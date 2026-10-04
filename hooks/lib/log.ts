// The local routing log: one JSON object per line, one file per UTC day and
// session, under the log directory. Nothing is sent anywhere. Prompt text is
// left out unless `log_prompts` is on; a short SHA-256 prefix lets repeated
// prompts be recognised without storing them.

import type { Decision, Effort, Level, Source } from "./types.ts"

export const LOG_VERSION = 1

export type AnsweredUsage = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type TurnRecord = {
  v: number
  type: "turn"
  ts: string
  session: string
  turn: string
  kind: Decision["kind"]
  source: Source
  promptHash?: string
  promptChars: number
  prompt?: string
  provider?: string
  recommendation?: {
    level: Level
    confidence: number
    probabilities: Record<Level, number>
    score?: number
    followUp?: number
  }
  latencyMs?: number
  clefInputTokens?: number
  proposed?: { level?: Level; model: string; effort?: Effort }
  final?: { level?: Level; model: string; effort?: Effort }
  adjustments: { rule: string; from: string; to: string; reason: string }[]
  failure?: { kind: string; message: string; status?: number }
  note?: string
  /** What the API said answered, summed over the turn's main-loop requests. */
  answered?: AnsweredUsage
  steps?: number
  durationMs?: number
  endReason?: string
}

export type FeedbackRecord = {
  v: number
  type: "feedback"
  ts: string
  session: string
  turn?: string
  verdict: "under" | "ok" | "over"
  note?: string
}

export type LogRecord = TurnRecord | FeedbackRecord

export async function promptHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("")
}

export function turnRecord(args: {
  decision: Decision
  session: string
  ts: string
  promptText: string
  hash?: string
  logPrompts: boolean
  answered?: AnsweredUsage
  steps?: number
  durationMs?: number
  endReason?: string
}): TurnRecord {
  const { decision: d } = args
  const record: TurnRecord = {
    v: LOG_VERSION,
    type: "turn",
    ts: args.ts,
    session: args.session,
    turn: d.turnId,
    kind: d.kind,
    source: d.source,
    promptChars: args.promptText.length,
    adjustments: d.adjustments.map((a) => ({ ...a })),
  }
  if (args.hash) record.promptHash = args.hash
  if (args.logPrompts) record.prompt = args.promptText
  const rec = d.recommendation
  if (rec) {
    record.provider = rec.provider
    record.recommendation = { level: rec.level, confidence: rec.confidence, probabilities: { ...rec.probabilities } }
    if (rec.score !== undefined) record.recommendation.score = rec.score
    if (rec.contextDependent !== undefined) record.recommendation.followUp = rec.contextDependent
    record.latencyMs = rec.latencyMs
    if (rec.inputTokens !== undefined) record.clefInputTokens = rec.inputTokens
  }
  if (d.failure) {
    record.failure = { kind: d.failure.kind, message: d.failure.message }
    if (d.failure.status !== undefined) record.failure.status = d.failure.status
    if (d.failure.latencyMs > 0) record.latencyMs = d.failure.latencyMs
  }
  if (d.proposed) record.proposed = { ...d.proposed }
  if (d.final) record.final = { ...d.final }
  if (d.note) record.note = d.note
  if (args.answered) record.answered = { ...args.answered }
  if (args.steps !== undefined) record.steps = args.steps
  if (args.durationMs !== undefined) record.durationMs = args.durationMs
  if (args.endReason) record.endReason = args.endReason
  return record
}

export function logFileName(ts: string, session: string): string {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "session"
  return `routing-${ts.slice(0, 10)}-${safe}.jsonl`
}

export function parseLines(text: string): LogRecord[] {
  const out: LogRecord[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const value = JSON.parse(line) as LogRecord
      if (value && typeof value === "object" && (value.type === "turn" || value.type === "feedback")) out.push(value)
    } catch {
      // A torn line from a crash mid-write; skip it.
    }
  }
  return out
}

export type Stats = {
  turns: number
  bySource: Record<string, number>
  byModel: Record<string, number>
  byEffort: Record<string, number>
  byLevel: Record<string, number>
  clefCalls: number
  latency: { mean: number; p50: number; p95: number } | undefined
  meanConfidence: number | undefined
  failures: Record<string, number>
  overrides: number
  cacheHolds: number
  adjusted: number
  /** Turns where Clef's raw level differs from the final route's level. */
  recommendationChanged: number
  feedback: Record<string, number>
  clefInputTokens: number
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[i]!
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1
}

export function aggregate(records: readonly LogRecord[]): Stats {
  const stats: Stats = {
    turns: 0,
    bySource: {},
    byModel: {},
    byEffort: {},
    byLevel: {},
    clefCalls: 0,
    latency: undefined,
    meanConfidence: undefined,
    failures: {},
    overrides: 0,
    cacheHolds: 0,
    adjusted: 0,
    recommendationChanged: 0,
    feedback: {},
    clefInputTokens: 0,
  }
  const latencies: number[] = []
  let confidenceSum = 0
  let confidenceN = 0
  for (const r of records) {
    if (r.type === "feedback") {
      bump(stats.feedback, r.verdict)
      continue
    }
    stats.turns++
    bump(stats.bySource, r.source)
    const model = r.answered?.model ?? r.final?.model ?? "session default"
    bump(stats.byModel, model.replace(/-\d{8}$/, ""))
    bump(stats.byEffort, r.final ? (r.final.effort ?? "default") : "untouched")
    if (r.final?.level) bump(stats.byLevel, r.final.level)
    if (r.recommendation || r.failure) {
      if (r.failure?.kind !== "not-configured" && r.failure?.kind !== "budget" && r.failure?.kind !== "circuit-open") stats.clefCalls++
    }
    if (r.recommendation) {
      if (r.latencyMs !== undefined) latencies.push(r.latencyMs)
      confidenceSum += r.recommendation.confidence
      confidenceN++
      if (r.final?.level !== r.recommendation.level || r.final?.model !== r.proposed?.model) stats.recommendationChanged++
    }
    if (r.failure) bump(stats.failures, r.failure.kind)
    if (r.source === "override" || r.source === "pin") stats.overrides++
    if (r.adjustments.some((a) => a.rule === "cache-hold")) stats.cacheHolds++
    if (r.adjustments.length > 0) stats.adjusted++
    stats.clefInputTokens += r.clefInputTokens ?? 0
  }
  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b)
    stats.latency = {
      mean: Math.round(sorted.reduce((s, x) => s + x, 0) / sorted.length),
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
    }
  }
  if (confidenceN > 0) stats.meanConfidence = confidenceSum / confidenceN
  return stats
}
