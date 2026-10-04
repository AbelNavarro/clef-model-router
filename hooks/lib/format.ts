// Everything the router shows: the one-line status, and the text of each
// /clef subcommand. Plain text, so it reads the same on every surface.

import type { BillingOption, Config } from "./config.ts"
import type { BillingFacts } from "./env.ts"
import { displayName, resolveModel, type ModelEnv } from "./models.ts"
import { describe, kTokens, pct, type HoldState, type RouterMode } from "./policy.ts"
import { dollars, type Billing } from "./pricing.ts"
import { presence } from "./redact.ts"
import type { Stats } from "./log.ts"
import { LEVELS, type Decision, type Level, type Target } from "./types.ts"

const RULE_LABEL: Record<string, string> = {
  "low-confidence": "unsure",
  "context-dependent": "follow-up",
  unavailable: "unavailable",
  "context-window": "window",
  "cache-hold": "held for cache",
  "effort-clamp": "effort clamped",
  "effort-cap": "effort capped",
  "pinned-effort": "pinned effort",
}

/**
 * A held downgrade names what it held back, so a route that differs from
 * Clef's pick says so: "(Sonnet deferred)", or "(low effort deferred)".
 */
function holdLabel(d: Decision): string {
  const w = d.deferral?.wanted
  if (!w || !d.final) return RULE_LABEL["cache-hold"]!
  return w.model === d.final.model ? `${w.effort ?? "lower"} effort deferred` : `${displayName(w.model)} deferred`
}

/** The one line under the prompt, e.g. "Clef → Sonnet · medium · 87%". */
export function statusLine(d: Decision): string | undefined {
  const route = d.final ? describe(d.final) : undefined
  const notes = d.adjustments.map((a) => (a.rule === "cache-hold" ? holdLabel(d) : (RULE_LABEL[a.rule] ?? a.rule)))
  const tail = notes.length > 0 ? ` (${[...new Set(notes)].join(", ")})` : ""
  switch (d.source) {
    case "clef": {
      const conf = d.recommendation ? ` · ${pct(d.recommendation.confidence)}` : ""
      return `Clef → ${route}${conf}${tail}`
    }
    case "fallback":
      return `Clef ✕ ${d.failure?.kind ?? "no answer"} → ${route}${tail}`
    case "continuation":
      return route ? `Clef ↻ ${route}${tail}` : undefined
    case "override":
      return route ? `+ ${route}${tail}` : `+ ${d.note ?? "override"}`
    case "pin":
      return route ? `Pinned → ${route}${tail}` : `Pinned: ${d.note ?? ""}`
    case "native":
      return "Clef paused (you chose /model)"
    case "disabled":
      return d.note?.startsWith("+off") ? "Clef skipped this turn" : "Clef off"
  }
}

/** A line under the answer, when `announce` asks for one. */
export function answerLine(d: Decision, latencyMs?: number): string | undefined {
  const line = statusLine(d)
  if (!line) return undefined
  return latencyMs !== undefined && d.source === "clef" ? `${line} · ${latencyMs} ms` : line
}

function bar(p: number, width = 20): string {
  const filled = Math.round(p * width)
  return "█".repeat(filled) + "·".repeat(width - filled)
}

export function distribution(probabilities: Record<Level, number>, mark?: Level, final?: Level): string[] {
  return LEVELS.map((level) => {
    const tags = [level === mark ? "← Clef" : "", level === final && final !== mark ? "← routed" : ""].filter(Boolean).join(" ")
    return `    ${level.padEnd(9)} ${bar(probabilities[level])} ${pct(probabilities[level]).padStart(4)}  ${tags}`.trimEnd()
  })
}

export function explain(d: Decision): string[] {
  const lines: string[] = []
  lines.push(`  route     ${d.final ? `${describe(d.final)}  (${d.final.model}${d.final.level ? `, profile ${d.final.level}` : ""})` : "untouched (Claude Code's own model and effort)"}`)
  lines.push(`  source    ${d.source}${d.note ? ` — ${d.note}` : ""}`)
  const rec = d.recommendation
  if (rec) {
    const extras = [
      `${pct(rec.confidence)} on ${rec.level}`,
      rec.providerConfidence !== undefined ? `clef confidence ${pct(rec.providerConfidence)}` : "",
      rec.score !== undefined ? `score ${rec.score.toFixed(2)}/4` : "",
      rec.contextDependent !== undefined ? `follow-up ${pct(rec.contextDependent)}` : "",
      `${rec.latencyMs} ms`,
      rec.inputTokens !== undefined ? `${rec.inputTokens} tokens` : "",
    ].filter(Boolean)
    lines.push(`  clef      ${rec.provider}: ${extras.join(" · ")}`)
    lines.push(...distribution(rec.probabilities, rec.level, d.final?.level))
  }
  if (d.failure) lines.push(`  failure   ${d.failure.kind}: ${d.failure.message}${d.failure.latencyMs ? ` (${d.failure.latencyMs} ms)` : ""}`)
  for (const a of d.adjustments) lines.push(`  policy    ${a.rule}: ${a.from} → ${a.to} — ${a.reason}`)
  const f = d.deferral
  if (f) {
    const what = f.wanted.model === f.from ? `${f.wanted.effort ?? "lower"} effort` : displayName(f.wanted.model)
    lines.push(
      f.held
        ? `  downgrade ${what} deferred (held turn ${f.turns}): staying has cost ${dollars(f.spent)} so far, a switch costs ${dollars(f.cost)} now (${f.billing}, list prices)`
        : `  downgrade ${what} taken after ${f.turns} held turn${f.turns === 1 ? "" : "s"}: staying had cost ${dollars(f.spent)}, the switch ${dollars(f.cost)} (${f.billing}, list prices)`,
    )
  }
  return lines
}

export type StatusArgs = {
  config: Config
  configProblems: readonly string[]
  modelEnv: ModelEnv
  mode: RouterMode
  pin?: Target
  last?: Decision
  guard: { calls: number; inputTokens: number; neurons: number; blocked?: string }
  cache?: { model: string; promptTokens: number; ageSeconds: number; ttlSeconds: number }
  billing: { billing: Billing; detected: BillingFacts; configured: BillingOption; patience: number }
  hold?: HoldState
  unavailable: readonly string[]
  logDir: string | undefined
  advancedPath?: string
}

export function targetText(t: Target): string {
  return [t.level ?? t.model ?? "", t.effort ? `:${t.effort}` : ""].join("")
}

export function statusReport(a: StatusArgs): string {
  const c = a.config
  const lines = ["Clef router"]
  const mode =
    !c.enabled ? "disabled in plugin config" : a.mode === "auto" ? (a.pin ? `pinned to ${targetText(a.pin)} (/clef auto to unpin)` : "auto") : a.mode === "off" ? "off for this session (/clef on)" : "paused: you changed /model (/clef auto to resume)"
  lines.push(`  mode      ${mode}`)
  lines.push(`  decider   ${c.decisionModel} · timeout ${c.timeoutMs} ms · account ${presence(c.accountId)} · token ${presence(c.apiToken)}`)
  const budget = c.dailyNeuronBudget > 0 ? ` of ${c.dailyNeuronBudget} budget` : ""
  lines.push(`  today     ${a.guard.calls} Clef calls · ${kTokens(a.guard.inputTokens)} input tokens · ~${Math.round(a.guard.neurons)} neurons${budget}${a.guard.blocked ? ` · ${a.guard.blocked}` : ""}`)
  const b = a.billing
  const source = b.configured === "auto" ? `detected: ${b.detected.why}` : `set in config; detected ${b.detected.billing} (${b.detected.why})`
  const patience = b.patience === 0 ? "downgrades taken at once" : `downgrade patience ${b.patience}`
  lines.push(`  billing   ${b.billing} (${source}) · ${patience}`)
  if (a.cache) {
    const warm = a.cache.ageSeconds < a.cache.ttlSeconds
    lines.push(`  cache     ${displayName(a.cache.model)} · ${kTokens(a.cache.promptTokens)} context · ${warm ? `warm (${a.cache.ageSeconds}s of ${a.cache.ttlSeconds}s)` : "cold"}`)
  }
  if (a.hold) {
    const what = a.hold.wanted.model === a.hold.model ? `${a.hold.wanted.effort ?? "lower"} effort` : displayName(a.hold.wanted.model)
    lines.push(`  deferred  ${what} · ${a.hold.turns} held turn${a.hold.turns === 1 ? "" : "s"} on ${displayName(a.hold.model)} · staying has cost ${dollars(a.hold.spent)} (list prices)`)
  }
  if (a.unavailable.length > 0) lines.push(`  unusable  ${a.unavailable.join(", ")}`)
  for (const p of a.configProblems) lines.push(`  config!   ${p}`)
  if (a.last) {
    lines.push("", "Last turn")
    lines.push(...explain(a.last))
  } else {
    lines.push("", "No turn routed yet this session.")
  }
  if (a.advancedPath) lines.push("", `Advanced settings: ${a.advancedPath} (optional)`)
  lines.push(`Log: ${c.logEnabled ? (a.logDir ?? "(unavailable)") : "off"}${c.logEnabled && c.logPrompts ? " (with prompt text)" : ""}`)
  lines.push("Commands: /clef history · stats · profiles · test <prompt> · pin <target> · auto · off · on · feedback under|ok|over")
  return lines.join("\n")
}

export function profilesReport(config: Config, env: ModelEnv, unavailable: readonly string[]): string {
  const lines = ["Profiles, lowest first. Change them with /config (Profiles) or /plugin configure."]
  for (const level of LEVELS) {
    const spec = config.profiles[level]
    const id = resolveModel(spec.model, env)
    const state = id === undefined ? "cannot resolve here (set a full model ID)" : unavailable.includes(id) ? `${id} (failed this session)` : id
    lines.push(`  ${level.padEnd(9)} ${`${spec.model}${spec.effort ? `:${spec.effort}` : ""}`.padEnd(16)} → ${state}`)
  }
  lines.push(`  fallback  ${config.fallbackLevel} · low confidence (< ${pct(config.confidenceThreshold)}): ${config.lowConfidencePolicy}`)
  return lines.join("\n")
}

export type HistoryRow = { decision: Decision; prompt: string; answeredModel?: string }

export function historyReport(rows: readonly HistoryRow[]): string {
  if (rows.length === 0) return "No turns yet this session."
  const lines = ["Turns this session, newest first"]
  lines.push("     ms  route                  conf  source        prompt")
  for (const row of [...rows].reverse()) {
    const d = row.decision
    const ms = d.recommendation?.latencyMs ?? d.failure?.latencyMs
    const conf = d.recommendation ? pct(d.recommendation.confidence) : "—"
    const route = d.final ? describe(d.final) : "untouched"
    const flag = d.adjustments.length > 0 ? "*" : " "
    const prompt = row.prompt.replace(/\s+/g, " ").slice(0, 48)
    lines.push(`  ${String(ms ?? "—").padStart(5)}  ${(route + flag).padEnd(22)} ${conf.padStart(4)}  ${d.source.padEnd(12)}  ${prompt}`)
    for (const a of d.adjustments) lines.push(`         ${a.rule}: ${a.from} → ${a.to}`)
    if (d.failure) lines.push(`         ${d.failure.kind}: ${d.failure.message}`)
    if (row.answeredModel && d.final && !row.answeredModel.startsWith(d.final.model)) lines.push(`         answered by ${row.answeredModel}`)
  }
  lines.push("  * policy changed Clef's recommendation")
  return lines.join("\n")
}

function table(title: string, map: Record<string, number>, total: number): string[] {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return []
  return [`  ${title}`, ...entries.map(([k, v]) => `    ${k.padEnd(24)} ${String(v).padStart(5)}  ${pct(total ? v / total : 0).padStart(4)}`)]
}

export function statsReport(s: Stats, days: number, files: number): string {
  if (s.turns === 0 && Object.keys(s.feedback).length === 0) return `No routing log entries in the last ${days} day(s).`
  const lines = [`Routing over the last ${days} day(s): ${s.turns} turns in ${files} log file(s)`]
  lines.push(...table("by model", s.byModel, s.turns))
  lines.push(...table("by effort", s.byEffort, s.turns))
  lines.push(...table("by profile", s.byLevel, s.turns))
  lines.push(...table("by source", s.bySource, s.turns))
  lines.push("  clef")
  lines.push(`    calls ${s.clefCalls} · ${kTokens(s.clefInputTokens)} input tokens`)
  if (s.latency) lines.push(`    latency mean ${s.latency.mean} ms · p50 ${s.latency.p50} ms · p95 ${s.latency.p95} ms`)
  if (s.meanConfidence !== undefined) lines.push(`    mean probability of Clef's pick ${pct(s.meanConfidence)}`)
  lines.push(`    recommendation changed by policy: ${s.recommendationChanged} · manual overrides: ${s.overrides}`)
  lines.push(`    turns held on a warm model: ${s.cacheHolds} · downgrades taken after a hold: ${s.downgradesTaken}`)
  const failures = Object.entries(s.failures)
  if (failures.length > 0) lines.push(`    fallbacks: ${failures.map(([k, v]) => `${k} ${v}`).join(", ")}`)
  const fb = Object.entries(s.feedback)
  if (fb.length > 0) lines.push(`  your feedback: ${fb.map(([k, v]) => `${k} ${v}`).join(", ")}`)
  return lines.join("\n")
}

export const HELP = [
  "Clef router — picks the Claude model and effort for each turn.",
  "",
  "  /clef                  status and the last decision, with Clef's probabilities",
  "  /clef history          this session's turns",
  "  /clef stats [days]     totals from the local log (default 7 days)",
  "  /clef profiles         what each difficulty level runs on",
  "  /clef test <prompt>    ask Clef about a prompt without sending it to Claude",
  "  /clef pin <target>     use one target for the rest of the session",
  "                         target: trivial|simple|standard|hard|deep, haiku|sonnet|opus|fable,",
  "                         a model ID, with optional :effort; or :effort alone",
  "  /clef auto             unpin, resume after /model, and hand effort back after /effort",
  "  /clef off | on         stop or resume routing for this session",
  "  /clef feedback under|ok|over [note]   rate the last route, for later analysis",
  "",
  "One turn only: start a prompt with +target, e.g. `+opus:max why does this deadlock?`,",
  "or `+off ...` to leave that turn to Claude Code.",
].join("\n")
