// clef-model-router: picks the Claude model and effort for each turn with
// Cloudflare Clef.
//
//   prompt.submit  a `+target ` prefix is taken off the prompt and kept for the turn
//   turn.start     one Clef call (or none), then the policy decides the turn's route
//   turn.step      every main-loop request of the turn is sent with that route
//   turn.complete  the outcome goes to the local log
//   /clef          status, history, stats, test, pin, auto, off, on, feedback
//
// The decision is made once per turn, at turn.start, where the person's text
// is: a turn's later requests (after each tool result) reuse it, so a turn
// pays Clef's latency once and never changes model halfway. Subagents keep
// their own model. Every failure path leaves the request as Claude Code made
// it, or on a deterministic fallback.

import type { EngineInterface, PluginOptions, Register } from "claude-code"

import { clefProvider } from "./lib/clef.ts"
import { parseAdvancedFile, parseConfig, type Config } from "./lib/config.ts"
import { cacheTtlMs, modelEnvFrom, type EnvValues } from "./lib/env.ts"
import {
  HELP,
  answerLine,
  explain,
  historyReport,
  profilesReport,
  statsReport,
  statusLine,
  statusReport,
  targetText,
  type HistoryRow,
} from "./lib/format.ts"
import { blockedReason, estimatedNeurons, normaliseGuard, recordFailure, recordSuccess, type GuardState } from "./lib/guard.ts"
import { aggregate, logFileName, parseLines, promptHash, turnRecord, type AnsweredUsage, type FeedbackRecord } from "./lib/log.ts"
import { clampEffort, effortsFor, isEffort, sameModel, type ModelEnv } from "./lib/models.ts"
import { parseCommand, parsePrefix, trackNativeEffort, turnKind, type ClefCommand } from "./lib/overrides.ts"
import { decide, describe, needsClef, type CacheState, type RouterMode } from "./lib/policy.ts"
import { DEFAULT_RUBRIC, parseRubric, type Rubric } from "./lib/rubric.ts"
import type { Decision, ProviderResult, Route, Target } from "./lib/types.ts"

const PLUGIN = "clef-model-router"
const SESSION_REF = { plugin: "clef-model-router", key: "session" } as const
const GUARD_KEY = "guard"
const HISTORY_LIMIT = 50
const RUN_LIMIT = 32
/** A routed model that fails this many requests in a row is not used again this session. */
const FAILURES_BEFORE_UNAVAILABLE = 2

/** What survives a hot reload (in `$.state`) for the rest of the session. */
type Persisted = {
  mode: RouterMode
  pin?: Target
  pendingOverride?: Target | "off"
  last?: Route
  cache?: CacheState
  unavailable: string[]
  failures: Record<string, number>
  /** The session model Claude Code reported at the last turn. */
  baselineModel?: string
  /** Effort as Claude Code itself would send it, and any /effort the person set. */
  effortBaseline?: string | number
  nativeEffort?: string | number
  /** A model Claude Code fell back to during the last turn, so it is not mistaken for a /model change. */
  engineFallback?: string
  history: HistoryRow[]
  warned: string[]
}

/** One turn in flight. Module memory only: a reload mid-turn leaves it unrouted. */
type Run = {
  decision: Decision
  prompt: string
  hash?: string
  engineModel?: string
  passthrough: boolean
  failedRewrite: boolean
  steps: number
  answered?: AnsweredUsage
}

// Module state. `register` runs again on every reload, which resets these;
// `load` then restores the session's part from `$.state`.
let options: PluginOptions = {}
let state: Persisted = freshState()
let loaded = false
let config: Config = parseConfig({}).config
let problems: string[] = []
let modelEnv: ModelEnv = modelEnvFrom({})
let ttlMs = 5 * 60_000
let rubric: Rubric = DEFAULT_RUBRIC
let logDir: string | undefined
let apiBase: string | undefined
let advancedPath: string | undefined
let logFile: string | undefined
let logLines: string[] = []
const runs = new Map<string, Run>()

function freshState(): Persisted {
  return { mode: "auto", unavailable: [], failures: {}, history: [], warned: [] }
}

async function save($: EngineInterface): Promise<void> {
  try {
    await $.state.set(SESSION_REF, JSON.stringify(state))
  } catch {
    // Losing the snapshot only matters on a hot reload; routing goes on.
  }
}

async function readEnv($: EngineInterface): Promise<EnvValues> {
  return {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: await $.env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ANTHROPIC_DEFAULT_SONNET_MODEL: await $.env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ANTHROPIC_DEFAULT_OPUS_MODEL: await $.env.get("ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ANTHROPIC_DEFAULT_FABLE_MODEL: await $.env.get("ANTHROPIC_DEFAULT_FABLE_MODEL"),
    CLAUDE_CODE_USE_BEDROCK: await $.env.get("CLAUDE_CODE_USE_BEDROCK"),
    CLAUDE_CODE_USE_VERTEX: await $.env.get("CLAUDE_CODE_USE_VERTEX"),
    CLAUDE_CODE_USE_FOUNDRY: await $.env.get("CLAUDE_CODE_USE_FOUNDRY"),
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: await $.env.get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"),
    // Only whether it is set: the key itself is never kept.
    ANTHROPIC_API_KEY: (await $.env.get("ANTHROPIC_API_KEY")) ? "set" : undefined,
    CLAUDE_CODE_PROMPT_CACHE_TTL: await $.env.get("CLAUDE_CODE_PROMPT_CACHE_TTL"),
    FORCE_PROMPT_CACHING_5M: await $.env.get("FORCE_PROMPT_CACHING_5M"),
    ENABLE_PROMPT_CACHING_1H: await $.env.get("ENABLE_PROMPT_CACHING_1H"),
  }
}

/** Reads configuration and restores the session snapshot, once per load. */
async function load($: EngineInterface): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const home = (await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE")) ?? "."
    const configDir = (await $.env.get("CLAUDE_CONFIG_DIR")) ?? `${home}/.claude`
    advancedPath = (await $.env.get("CLEF_ROUTER_CONFIG")) ?? `${configDir}/${PLUGIN}.json`
    const advancedText = await $.fs.read(advancedPath).catch(() => undefined)
    const advanced = parseAdvancedFile(typeof advancedText === "string" ? advancedText : undefined)
    const parsed = parseConfig(
      { ...advanced.values, ...options },
      { accountId: await $.env.get("CLOUDFLARE_ACCOUNT_ID"), apiToken: await $.env.get("CLOUDFLARE_API_TOKEN") },
    )
    config = parsed.config
    problems = [...advanced.problems, ...parsed.problems]
    const env = await readEnv($)
    modelEnv = modelEnvFrom(env)
    const settings = (await $.settings.read().catch(() => ({}))) as Record<string, unknown>
    ttlMs = cacheTtlMs(config.cacheTtlMinutes, env, settings.promptCacheTtl)
    if (config.rubricFile) {
      const text = await $.fs.read(config.rubricFile).catch(() => undefined)
      const result = typeof text === "string" ? parseRubric(text) : { problems: [`cannot read rubric_file ${config.rubricFile}`] }
      if ("rubric" in result) rubric = result.rubric
      else problems.push(...result.problems.map((p) => `${p}; using the built-in rubric`))
    }
    const base = await $.env.get("CLEF_ROUTER_API_BASE")
    if (base && /^https?:\/\//.test(base)) apiBase = base
    logDir = config.logDir ?? `${configDir}/plugins/data/${PLUGIN}`
    const snapshot = await $.state.get(SESSION_REF)
    if (typeof snapshot.value === "string") state = { ...freshState(), ...(JSON.parse(snapshot.value) as Partial<Persisted>) }
  } catch (error) {
    problems.push(`setup: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readGuard($: EngineInterface, now: number): Promise<GuardState> {
  return normaliseGuard(await $.store.get(GUARD_KEY).catch(() => undefined), now)
}

async function askClef($: EngineInterface, prompt: string): Promise<ProviderResult> {
  const now = await $.clock.now()
  const guard = await readGuard($, now)
  const blocked = blockedReason(guard, { now, model: config.decisionModel, dailyNeuronBudget: config.dailyNeuronBudget })
  if (blocked) return { ok: false, failure: blocked }
  const provider = clefProvider({
    accountId: config.accountId,
    apiToken: config.apiToken,
    model: config.decisionModel,
    rubric,
    timeoutMs: config.timeoutMs,
    maxPromptChars: config.maxPromptChars,
    ...(apiBase ? { apiBase } : {}),
    fetch: async (url, init) => {
      const r = await $.http.fetch(url, init)
      return { status: r.status, ok: r.ok, text: r.text }
    },
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    now: () => $.clock.now(),
  })
  const result = await provider.decide(prompt)
  const after = result.ok ? recordSuccess(guard, result.recommendation.inputTokens) : recordFailure(guard, result.failure, await $.clock.now())
  if (after !== guard) await $.store.set(GUARD_KEY, after).catch(() => {})
  return result
}

/** One-time notices, so a misconfiguration is said once, not every turn. */
function warnOnce($: EngineInterface, key: string, text: string): void {
  if (state.warned.includes(key)) return
  state.warned.push(key)
  $.ui.toast(text, { timeoutMs: 8000 })
}

/** The route line, drawn dim at the end of the hint line under the prompt. */
let hint: string | undefined

/**
 * Shows the route without Claude Code's status-line marker (a ⚠ that reads as
 * a warning): the text joins the prompt's hint line as its tail, prefixed ↳.
 * The terminal draws that tail; elsewhere `announce: "answer"` shows the route.
 */
function showStatus($: EngineInterface, text: string | undefined): void {
  const next = text === undefined ? undefined : `↳ ${text}`
  if (next === hint) return
  hint = next
  $.ui.invalidate("ui.render")
}

function announce($: EngineInterface, d: Decision): void {
  if (config.announce === "status" || config.announce === "both") showStatus($, statusLine(d))
}

async function appendLog($: EngineInterface, line: string, ts: string): Promise<void> {
  if (!config.logEnabled || !logDir) return
  try {
    const file = `${logDir}/${logFileName(ts, await $.session.id())}`
    if (file !== logFile) {
      logFile = file
      const existing = await $.fs.read(file).catch(() => "")
      logLines = typeof existing === "string" && existing !== "" ? existing.trimEnd().split("\n") : []
    }
    logLines.push(line)
    await $.fs.write(file, logLines.join("\n") + "\n")
  } catch {
    // A log that cannot be written must not cost the turn anything.
  }
}

/** Notices a /model change made between turns: the person taking over the model. */
async function noticeNativeModel($: EngineInterface): Promise<void> {
  const sessionModel = await $.session.model().catch(() => undefined)
  if (sessionModel && state.baselineModel && !sameModel(sessionModel, state.baselineModel)) {
    // A fallback Claude Code made itself (a safety classifier moving the
    // session) is not one.
    const engineMoved = state.engineFallback !== undefined && sameModel(sessionModel, state.engineFallback)
    if (!engineMoved && state.mode === "auto" && config.pauseOnNativeChange) {
      state.mode = "paused-native"
      $.ui.toast(`Clef paused: you switched to ${sessionModel}. /clef auto resumes routing.`, { timeoutMs: 8000 })
    }
  }
  delete state.engineFallback
  if (sessionModel) state.baselineModel = sessionModel
}

async function routeTurn($: EngineInterface, turnId: string, text: string): Promise<void> {
  const kind = turnKind(text)
  const override = state.pendingOverride
  delete state.pendingOverride
  await noticeNativeModel($)

  const base = { turnId, kind, config, modelEnv, session: state, ...(override ? { override } : {}) }
  const result = needsClef(base) ? await askClef($, text) : undefined
  const usage = await $.session.usage().catch(() => undefined)
  const now = await $.clock.now()
  const decision = decide({
    ...base,
    ...(result ? { result } : {}),
    ...(usage?.context?.tokens ? { contextTokens: usage.context.tokens } : {}),
    now,
    cacheTtlMs: ttlMs,
  })

  const kindOfFailure = decision.failure?.kind
  if (kindOfFailure === "not-configured")
    warnOnce($, "not-configured", `Clef router: set your Cloudflare account ID and API token with /plugin configure ${PLUGIN}. Using the ${config.fallbackLevel} profile meanwhile.`)
  else if (kindOfFailure === "auth")
    warnOnce($, "auth", `Clef router: Cloudflare rejected the API token (${decision.failure?.message}). Falling back until it is fixed.`)
  else if (kindOfFailure === "quota")
    warnOnce($, `quota-${new Date(now).toISOString().slice(0, 10)}`, "Clef router: Workers AI's free daily allocation is used up; falling back until 00:00 UTC.")

  if (decision.final) state.last = decision.final
  const run: Run = { decision, prompt: text, passthrough: !decision.final, failedRewrite: false, steps: 0 }
  const hash = await promptHash(text).catch(() => undefined)
  if (hash) run.hash = hash
  runs.set(turnId, run)
  while (runs.size > RUN_LIMIT) runs.delete(runs.keys().next().value!)
  state.history.push({ decision, prompt: text.slice(0, 200) })
  while (state.history.length > HISTORY_LIMIT) state.history.shift()
  announce($, decision)
  await save($)
}

/** Watches Claude Code's own model and effort at a main-loop step, before any rewrite. */
function noticeStep($: EngineInterface, run: Run, model: string, effort: string | number | undefined, index: number): void {
  if (index === 0) {
    run.engineModel = model
    const tracked = trackNativeEffort({ baseline: state.effortBaseline, native: state.nativeEffort }, effort)
    state.effortBaseline = tracked.baseline
    if (tracked.native === undefined) delete state.nativeEffort
    else state.nativeEffort = tracked.native
    if (!config.pauseOnNativeChange) return
    if (tracked.change === "set" && state.mode === "auto")
      $.ui.toast(`Clef: using your effort ${String(tracked.native)}; Clef still picks the model. /clef auto hands effort back.`, { timeoutMs: 8000 })
    // The person's /effort beats Clef's, not an explicit +target or pin.
    const d = run.decision
    if (state.nativeEffort !== undefined && d.final && (d.source === "clef" || d.source === "continuation" || d.source === "fallback")) {
      const wanted = typeof state.nativeEffort === "string" && isEffort(state.nativeEffort) ? state.nativeEffort : undefined
      const effortNow = wanted ? clampEffort(d.final.model, wanted) : undefined
      if (effortNow !== d.final.effort) {
        const final = { ...d.final }
        if (effortNow) final.effort = effortNow
        else delete final.effort
        run.decision = {
          ...d,
          final,
          adjustments: [...d.adjustments, { rule: "pinned-effort", from: d.final.effort ?? "default", to: effortNow ?? "default", reason: "your /effort" }],
        }
        state.last = final
        announce($, run.decision)
      }
    }
  } else if (run.engineModel && !sameModel(model, run.engineModel)) {
    // Claude Code moved the turn to a fallback model (an error, or a safety
    // classifier). That is never overridden.
    run.passthrough = true
    state.engineFallback = model
  }
}

/** Records what a step's response says: failures of a routed model, usage, cache. */
async function afterStep(
  $: EngineInterface,
  run: Run,
  sent: { model: string; effort?: unknown },
  rewritten: boolean,
  result: { stopReason: string | null; usage: { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null },
  aborted: boolean,
): Promise<void> {
  const now = await $.clock.now()
  if (rewritten) {
    if (result.stopReason === null && !aborted) {
      // The routed request got no response: stop routing this turn, and stop
      // using the model after repeated failures.
      run.failedRewrite = true
      const n = (state.failures[sent.model] ?? 0) + 1
      state.failures[sent.model] = n
      if (n >= FAILURES_BEFORE_UNAVAILABLE && !state.unavailable.includes(sent.model)) {
        state.unavailable.push(sent.model)
        $.ui.toast(`Clef router: ${sent.model} failed ${n} times; not routing to it again this session.`, { timeoutMs: 8000 })
      }
    } else if (result.stopReason !== null) {
      state.failures[sent.model] = 0
    }
  }
  const u = result.usage
  if (u) {
    const a = run.answered ?? { model: u.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    run.answered = {
      model: u.model,
      inputTokens: a.inputTokens + u.input_tokens,
      outputTokens: a.outputTokens + u.output_tokens,
      cacheReadTokens: a.cacheReadTokens + u.cache_read_input_tokens,
      cacheWriteTokens: a.cacheWriteTokens + u.cache_creation_input_tokens,
    }
    const cache: CacheState = {
      model: sent.model,
      at: now,
      promptTokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
    }
    if (typeof sent.effort === "string" && isEffort(sent.effort)) cache.effort = sent.effort
    state.cache = cache
  }
  await save($)
}

async function completeTurn($: EngineInterface, run: Run, durationMs: number, reason: string): Promise<void> {
  const ts = new Date(await $.clock.now()).toISOString()
  const record = turnRecord({
    decision: run.decision,
    session: await $.session.id(),
    ts,
    promptText: run.prompt,
    ...(run.hash ? { hash: run.hash } : {}),
    logPrompts: config.logPrompts,
    ...(run.answered ? { answered: run.answered } : {}),
    steps: run.steps,
    durationMs,
    endReason: reason,
  })
  await appendLog($, JSON.stringify(record), ts)
  const row = state.history.find((h) => h.decision.turnId === run.decision.turnId)
  if (row) {
    row.decision = run.decision
    if (run.answered) row.answeredModel = run.answered.model
    await save($)
  }
}

async function registerCommand($: EngineInterface): Promise<void> {
  try {
    await $.command.register({
      name: "clef",
      description: "Clef router: status, history, stats, test, pin, auto, off, on, feedback",
      argumentHint: "[status|history|stats|profiles|test|pin|auto|off|on|feedback|help]",
      immediate: true,
    })
  } catch {
    // Without the command the router still routes.
  }
  if (!config.enabled) showStatus($, undefined)
  else if (!config.accountId || !config.apiToken) showStatus($, "Clef: not configured")
  else {
    // Always replace what an earlier load showed (a stale "not configured"
    // survives a reload otherwise): the last route if there is one.
    const last = state.history.at(-1)?.decision
    showStatus($, (last && statusLine(last)) ?? "Clef: awaiting prompt")
  }
}

async function onClear($: EngineInterface): Promise<void> {
  // /clear starts a new conversation: nothing is cached and nothing continues.
  delete state.last
  delete state.cache
  delete state.pendingOverride
  state.history = []
  runs.clear()
  logFile = undefined
  if (config.enabled && config.accountId && config.apiToken) showStatus($, "Clef: awaiting prompt")
  await save($)
}

async function setPendingOverride($: EngineInterface, override: Target | "off"): Promise<void> {
  await load($)
  state.pendingOverride = override
  await save($)
}

async function statusText($: EngineInterface, now: number): Promise<string> {
  const guard = await readGuard($, now)
  const blocked = blockedReason(guard, { now, model: config.decisionModel, dailyNeuronBudget: config.dailyNeuronBudget })
  const last = state.history.at(-1)?.decision
  return statusReport({
    config,
    configProblems: problems,
    modelEnv,
    mode: state.mode,
    ...(state.pin ? { pin: state.pin } : {}),
    ...(last ? { last } : {}),
    guard: {
      calls: guard.calls,
      inputTokens: guard.inputTokens,
      neurons: estimatedNeurons(guard, config.decisionModel),
      ...(blocked ? { blocked: blocked.message } : {}),
    },
    ...(state.cache
      ? {
          cache: {
            model: state.cache.model,
            promptTokens: state.cache.promptTokens,
            ageSeconds: Math.round((now - state.cache.at) / 1000),
            ttlSeconds: Math.round(ttlMs / 1000),
          },
        }
      : {}),
    unavailable: state.unavailable,
    logDir,
    ...(advancedPath ? { advancedPath } : {}),
  })
}

async function statsText($: EngineInterface, now: number, days: number): Promise<string> {
  if (!logDir) return "No log directory."
  const since = new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const entries = await $.fs.list(logDir).catch(() => [])
  const files = entries.filter((f) => /^routing-\d{4}-\d{2}-\d{2}-/.test(f.name) && f.name.slice(8, 18) >= since)
  const records = []
  for (const f of files) {
    const text = await $.fs.read(`${logDir}/${f.name}`).catch(() => "")
    if (typeof text === "string") records.push(...parseLines(text))
  }
  return statsReport(aggregate(records), days, files.length)
}

async function testText($: EngineInterface, now: number, prompt: string): Promise<string> {
  const result = await askClef($, prompt)
  const d = decide({
    turnId: "test",
    kind: turnKind(prompt),
    config,
    modelEnv,
    session: { ...state, mode: "auto" },
    result,
    now,
    cacheTtlMs: ttlMs,
  })
  return [`Clef on: ${prompt.slice(0, 80)}`, ...explain(d), "", "(Not sent to Claude. Counts toward today's Clef usage.)"].join("\n")
}

async function feedbackText($: EngineInterface, now: number, cmd: Extract<ClefCommand, { kind: "feedback" }>): Promise<string> {
  const last = state.history.at(-1)
  const record: FeedbackRecord = {
    v: 1,
    type: "feedback",
    ts: new Date(now).toISOString(),
    session: await $.session.id(),
    verdict: cmd.verdict,
    ...(last ? { turn: last.decision.turnId } : {}),
    ...(cmd.note ? { note: cmd.note } : {}),
  }
  await appendLog($, JSON.stringify(record), record.ts)
  const route = last?.decision.final ? describe(last.decision.final) : "the last turn"
  const verdict = cmd.verdict === "ok" ? "about right" : cmd.verdict === "under" ? "not capable enough" : "more than needed"
  return `Noted: ${route} was ${verdict}.`
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  await load($)
  const cmd = parseCommand(args)
  const now = await $.clock.now()
  switch (cmd.kind) {
    case "help":
      return HELP
    case "error":
      return cmd.message
    case "status":
      return statusText($, now)
    case "history":
      return historyReport(state.history)
    case "profiles":
      return profilesReport(config, modelEnv, state.unavailable)
    case "stats":
      return statsText($, now, cmd.days)
    case "test":
      return testText($, now, cmd.prompt)
    case "feedback":
      return feedbackText($, now, cmd)
    case "auto":
      state.mode = "auto"
      delete state.pin
      delete state.nativeEffort
      delete state.effortBaseline
      await save($)
      showStatus($, config.enabled ? `Clef auto · ${config.decisionModel}` : undefined)
      return config.enabled ? "Routing is automatic again." : "Routing is disabled in the plugin config (enabled = false)."
    case "on":
      state.mode = "auto"
      await save($)
      showStatus($, `Clef on · ${config.decisionModel}`)
      return state.pin ? `Routing on, still pinned to ${targetText(state.pin)} (/clef auto to unpin).` : "Routing on."
    case "off":
      state.mode = "off"
      await save($)
      showStatus($, "Clef off")
      return "Routing off for this session: Claude Code's own model and effort apply. /clef on resumes."
    case "pin":
      state.pin = cmd.target
      state.mode = "auto"
      await save($)
      showStatus($, `Pinned → ${targetText(cmd.target)}`)
      return `Pinned to ${targetText(cmd.target)} for this session. /clef auto unpins.`
  }
}

/** The request a step is sent with: the turn's route, effort fitted to the model. */
function routed<E extends { model: string; effort?: unknown }>(e: E, route: Route): E {
  const request = { ...e, model: route.model } as E & { effort?: unknown }
  if (effortsFor(route.model) === null) delete request.effort
  else if (route.effort) request.effort = route.effort
  else if (typeof e.effort === "string" && isEffort(e.effort)) {
    const clamped = clampEffort(route.model, e.effort)
    if (clamped) request.effort = clamped
  }
  return request
}

export const register: Register = (on, pluginOptions) => {
  options = pluginOptions
  state = freshState()
  hint = undefined
  apiBase = undefined
  loaded = false
  logFile = undefined
  logLines = []
  runs.clear()

  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    if (hint === undefined) return next(e)
    const tail = e.props.tail ? `${e.props.tail} · ${hint}` : `  ${hint}`
    return next({ ...e, props: { ...e.props, tail } })
  })

  on("session.start", async ($, e, next) => {
    await load($)
    await registerCommand($)
    return next(e)
  })

  on("session.end", async ($, e, next) => {
    if (e.reason === "clear") await onClear($)
    return next(e)
  })

  on("prompt.submit", async ($, e, next) => {
    // Only a prompt that starts a turn of its own; one typed into a running
    // turn joins that turn, which keeps its route.
    if (e.turnId !== undefined) return next(e)
    const parsed = parsePrefix(e.text)
    if (parsed.override === undefined) return next(e)
    await setPendingOverride($, parsed.override)
    return next({ ...e, text: parsed.text })
  })

  on("turn.start", async ($, e, next) => {
    try {
      await load($)
      await routeTurn($, e.turnId, e.text)
    } catch {
      // Unrouted: Claude Code's own model and effort apply.
    }
    return next(e)
  })

  on("turn.step", async function* ($, e, next) {
    // Subagents run on the model their definition or Claude Code gives them.
    const run = e.agentId === undefined ? runs.get(e.turnId) : undefined
    if (!run) return yield* next(e)
    run.steps++
    try {
      noticeStep($, run, e.model, e.effort, e.index)
    } catch {
      run.passthrough = true
    }
    const route = run.decision.final
    const rewrite = route !== undefined && !run.passthrough && !run.failedRewrite
    const request = rewrite ? routed(e, route) : e
    const result = yield* next(request)
    try {
      await afterStep($, run, request, rewrite, result, next.signal?.aborted === true)
    } catch {
      // Bookkeeping only.
    }
    return result
  })

  on("turn.complete", async ($, e, next) => {
    const result = await next(e)
    const run = e.agentId === undefined ? runs.get(e.turnId) : undefined
    if (!run) return result
    try {
      await completeTurn($, run, e.durationMs, e.reason)
    } catch {
      // Logging only.
    }
    if (config.announce === "answer" || config.announce === "both") {
      const line = answerLine(run.decision, run.decision.recommendation?.latencyMs)
      if (line) return { ...result, text: line }
    }
    return result
  })

  on("command.run", { command: "clef" }, async ($, e) => ({ text: await runCommand($, e.args) }))
}
