// Cloudflare Clef on Workers AI: the request, the response, and every way the
// exchange can fail, turned into a normalised Recommendation or a classified
// ProviderFailure. Nothing here throws.
//
// API (developers.cloudflare.com/workers-ai/models/clef-flash, Oct 2026):
//   POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}
//   Authorization: Bearer {token}
//   { "model": "clef-flash", "state": ..., "questions": { id: {type, instructions, criteria} } }
// → { "result": { "model", "answers": { id: answer }, "usage": { input_tokens, output_tokens } },
//     "success": true, "errors": [], "messages": [] }

import { buildQuestions, Q_DIFFICULTY, Q_FOLLOW_UP, type QuestionStyle, type Rubric } from "./rubric.ts"
import { redact } from "./redact.ts"
import { LEVELS, type DecisionProvider, type Level, type ProviderFailure, type ProviderResult, type Recommendation } from "./types.ts"

export const CLEF_MODELS = ["clef-flash", "clef"] as const
export type ClefModel = (typeof CLEF_MODELS)[number]

export const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4"

/** The slice of `$.http.fetch` (or the global fetch, in scripts) this needs. */
export type HttpLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; ok: boolean; text: string }>

export type ClefOptions = {
  accountId: string | undefined
  apiToken: string | undefined
  model: ClefModel
  rubric: Rubric
  style?: QuestionStyle
  timeoutMs: number
  maxPromptChars: number
  apiBase?: string
  fetch: HttpLike
  /** Resolves after `ms` (rejects if `signal` aborts); the timeout races the request against it. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  now: () => number | Promise<number>
}

export function endpoint(accountId: string, model: ClefModel, apiBase = DEFAULT_API_BASE): string {
  return `${apiBase.replace(/\/$/, "")}/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`
}

/**
 * Keeps the head and the tail of a long prompt. The request's intent is
 * usually stated at one end; the middle of a long paste rarely changes how
 * hard the task is, and every character sent is billed and leaves the machine.
 */
export function truncatePrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.75)
  const tail = maxChars - head
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - tail)}`
}

export function buildRequestBody(prompt: string, opts: Pick<ClefOptions, "model" | "rubric" | "style" | "maxPromptChars">): string {
  return JSON.stringify({
    model: opts.model,
    state: truncatePrompt(prompt, opts.maxPromptChars),
    questions: buildQuestions(opts.rubric, opts.style ?? "score"),
  })
}

type Envelope = {
  success?: unknown
  result?: unknown
  errors?: unknown
}

function errorsOf(envelope: Envelope): { code?: number; message: string }[] {
  if (!Array.isArray(envelope.errors)) return []
  return envelope.errors
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      code: typeof e.code === "number" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : "",
    }))
}

/** Maps an HTTP status and Cloudflare error envelope to a failure kind. */
export function classifyHttpFailure(
  status: number,
  bodyText: string,
  latencyMs: number,
  secrets: readonly (string | undefined)[] = [],
): ProviderFailure {
  let envelope: Envelope = {}
  try {
    envelope = JSON.parse(bodyText) as Envelope
  } catch {
    // Not JSON (a proxy's HTML page, say); the status alone decides.
  }
  const errors = errorsOf(envelope)
  const codes = errors.map((e) => e.code)
  const text = errors.map((e) => (e.code === undefined ? e.message : `${e.code}: ${e.message}`)).join("; ")
  const message = redact(text || `HTTP ${status}`, secrets).slice(0, 200)
  const quotaText = /daily free allocation|neurons/i.test(text)

  if (codes.includes(3036) || (status === 429 && quotaText)) return { kind: "quota", message, status, latencyMs }
  if (status === 429) return { kind: "rate-limited", message, status, latencyMs }
  if (status === 401 || status === 403 || codes.includes(10000)) return { kind: "auth", message, status, latencyMs }
  if (status === 408 || codes.includes(3007)) return { kind: "timeout", message, status, latencyMs }
  if (status >= 500) return { kind: "server", message, status, latencyMs }
  if (status >= 400) return { kind: "bad-request", message, status, latencyMs }
  return { kind: "malformed", message, status, latencyMs }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Reads a difficulty answer's per-level probabilities. A score answer keys
 * them by level index ("0".."4", per the schema), a choice answer by option
 * id (our level names). A 1-based index set is accepted too, defensively.
 */
export function levelProbabilities(answer: Record<string, unknown>, rubric: Rubric): Record<Level, number> | undefined {
  const raw = answer.probabilities
  if (typeof raw !== "object" || raw === null) return undefined
  const entries = Object.entries(raw as Record<string, unknown>)
  const out = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>
  const numericKeys = entries.every(([k]) => /^\d+$/.test(k))
  const base = numericKeys ? Math.min(...entries.map(([k]) => Number(k))) : 0
  let matched = 0
  for (const [key, value] of entries) {
    const p = num(value)
    if (p === undefined || p < 0 || p > 1.0001) return undefined
    let index: number
    if (numericKeys) index = Number(key) - (base === 1 && entries.length === LEVELS.length ? 1 : 0)
    else if ((LEVELS as readonly string[]).includes(key)) index = LEVELS.indexOf(key as Level)
    else index = rubric.levels.indexOf(key)
    const level = LEVELS[index]
    if (level === undefined) return undefined
    out[level] += p
    matched++
  }
  if (matched === 0) return undefined
  const total = LEVELS.reduce((s, l) => s + out[l], 0)
  if (total < 0.98 || total > 1.02) return undefined
  return out
}

/** The most probable level; a tie goes to the more capable one. */
export function topLevel(probabilities: Record<Level, number>): Level {
  let best: Level = LEVELS[0]
  for (const level of LEVELS) if (probabilities[level] >= probabilities[best]) best = level
  return best
}

/**
 * Turns a Workers AI success envelope into a Recommendation, or says why it
 * cannot. Exported for tests and the calibration script.
 */
export function parseResponse(
  bodyText: string,
  opts: { provider: string; rubric: Rubric; latencyMs: number },
): ProviderResult {
  const fail = (message: string): ProviderResult => ({
    ok: false,
    failure: { kind: "malformed", message, latencyMs: opts.latencyMs },
  })
  let envelope: Envelope
  try {
    envelope = JSON.parse(bodyText) as Envelope
  } catch {
    return fail("response is not JSON")
  }
  if (envelope.success === false) return { ok: false, failure: classifyHttpFailure(200, bodyText, opts.latencyMs) }
  const result = envelope.result as Record<string, unknown> | undefined
  if (typeof result !== "object" || result === null) return fail("response has no result")
  const answers = result.answers as Record<string, unknown> | undefined
  if (typeof answers !== "object" || answers === null) return fail("result has no answers")
  const difficulty = answers[Q_DIFFICULTY] as Record<string, unknown> | undefined
  if (typeof difficulty !== "object" || difficulty === null) return fail(`no answer for "${Q_DIFFICULTY}"`)

  const probabilities = levelProbabilities(difficulty, opts.rubric)
  if (probabilities === undefined) return fail("difficulty answer has no usable probabilities")
  const level = topLevel(probabilities)
  const confidence = num(difficulty.confidence)
  const score = num(difficulty.score)

  const followUp = answers[Q_FOLLOW_UP] as Record<string, unknown> | undefined
  const contextDependent = followUp && typeof followUp === "object" ? num(followUp.noul) : undefined

  const usage = result.usage as Record<string, unknown> | undefined
  const recommendation: Recommendation = {
    provider: opts.provider,
    level,
    confidence: probabilities[level],
    probabilities,
    latencyMs: opts.latencyMs,
  }
  if (confidence !== undefined && confidence >= 0 && confidence <= 1) recommendation.providerConfidence = confidence
  if (score !== undefined) recommendation.score = score
  if (contextDependent !== undefined && contextDependent >= 0 && contextDependent <= 1) recommendation.contextDependent = contextDependent
  const inputTokens = usage ? num(usage.input_tokens) : undefined
  if (inputTokens !== undefined) recommendation.inputTokens = inputTokens
  return { ok: true, recommendation }
}

const TIMED_OUT: unique symbol = Symbol("timeout")

/** The Clef provider. One HTTP request per call, no retries: a retry would
 * only add latency in the interactive path, and the fallback is cheap. */
export function clefProvider(opts: ClefOptions): DecisionProvider {
  const secrets = [opts.apiToken, opts.accountId]
  return {
    name: opts.model,
    async decide(prompt: string): Promise<ProviderResult> {
      if (!opts.accountId || !opts.apiToken) {
        return {
          ok: false,
          failure: { kind: "not-configured", message: "Cloudflare account ID or API token not set", latencyMs: 0 },
        }
      }
      const started = await opts.now()
      const elapsed = async () => Math.round((await opts.now()) - started)
      let response: { status: number; ok: boolean; text: string } | typeof TIMED_OUT
      const timer = new AbortController()
      try {
        const request = opts.fetch(endpoint(opts.accountId, opts.model, opts.apiBase), {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiToken}`, "Content-Type": "application/json" },
          body: buildRequestBody(prompt, opts),
        })
        // $.http.fetch takes no abort signal: on a timeout the request is left
        // to finish on its own, and its answer is ignored.
        request.catch(() => {})
        const deadline = opts.sleep(opts.timeoutMs, timer.signal).then(
          (): typeof TIMED_OUT => TIMED_OUT,
          (): typeof TIMED_OUT => TIMED_OUT,
        )
        response = await Promise.race([request, deadline])
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 200)
        return { ok: false, failure: { kind: "network", message, latencyMs: await elapsed() } }
      } finally {
        timer.abort()
      }
      const latencyMs = await elapsed()
      if (response === TIMED_OUT) {
        return { ok: false, failure: { kind: "timeout", message: `no answer within ${opts.timeoutMs} ms`, latencyMs } }
      }
      if (!response.ok) return { ok: false, failure: classifyHttpFailure(response.status, response.text, latencyMs, secrets) }
      return parseResponse(response.text, { provider: opts.model, rubric: opts.rubric, latencyMs })
    },
  }
}
