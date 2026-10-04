// Reads the plugin's `userConfig` values (set with /plugin configure or
// /config) into a validated Config. Bad values fall back to defaults and are
// reported, never thrown: a typo in one field must not stop Claude Code.

import { isEffort } from "./models.ts"
import { CLEF_MODELS, type ClefModel } from "./clef.ts"
import { EFFORTS, LEVELS, type Effort, type Level, type ProfileSpec } from "./types.ts"

export const LOW_CONFIDENCE_POLICIES = ["upper-of-top-two", "bump", "hold", "fallback", "obey"] as const
export type LowConfidencePolicy = (typeof LOW_CONFIDENCE_POLICIES)[number]

export const ANNOUNCE_MODES = ["status", "answer", "both", "off"] as const
export type AnnounceMode = (typeof ANNOUNCE_MODES)[number]

export type Config = {
  enabled: boolean
  accountId?: string
  apiToken?: string
  decisionModel: ClefModel
  timeoutMs: number
  profiles: Record<Level, ProfileSpec>
  confidenceThreshold: number
  lowConfidencePolicy: LowConfidencePolicy
  fallbackLevel: Level
  /** Honour /model (pause) and /effort (effort only) changes made mid-session. */
  pauseOnNativeChange: boolean
  /** P(follow-up) at or above which a prompt never routes below the last route. */
  followUpThreshold: number
  /** Hold a warm model on a downgrade when the context is at least this big; 0 = never hold. */
  cacheHoldMinTokens: number
  /** Prompt-cache TTL in minutes; 0 = work it out from the environment. */
  cacheTtlMinutes: number
  maxEffort?: Effort
  dailyNeuronBudget: number
  maxPromptChars: number
  announce: AnnounceMode
  logEnabled: boolean
  logPrompts: boolean
  logDir?: string
  rubricFile?: string
}

export const DEFAULT_PROFILES: Record<Level, string> = {
  trivial: "haiku",
  simple: "sonnet:low",
  standard: "sonnet:medium",
  hard: "opus:high",
  deep: "opus:xhigh",
}

export const DEFAULTS = {
  decisionModel: "clef-flash" as ClefModel,
  timeoutMs: 1500,
  confidenceThreshold: 0.55,
  lowConfidencePolicy: "upper-of-top-two" as LowConfidencePolicy,
  fallbackLevel: "standard" as Level,
  followUpThreshold: 0.6,
  cacheHoldMinTokens: 40_000,
  cacheTtlMinutes: 0,
  dailyNeuronBudget: 9_000,
  maxPromptChars: 6_000,
  announce: "status" as AnnounceMode,
}

/** "opus:high" → { model: "opus", effort: "high" }; "haiku" → { model: "haiku" }. */
export function parseProfile(level: Level, text: string): ProfileSpec | string {
  const trimmed = text.trim()
  if (trimmed === "") return `profile_${level} is empty`
  const split = splitTarget(trimmed)
  if (split.model === "") return `profile_${level} "${text}" names no model`
  if (split.badEffort) return `profile_${level} "${text}": effort must be one of ${EFFORTS.join(", ")}`
  return split.effort ? { level, model: split.model, effort: split.effort } : { level, model: split.model }
}

/**
 * Splits "model:effort". A suffix that is not an effort name stays part of
 * the model, since provider IDs carry colons ("...-v1:0" on Bedrock); a
 * suffix that looks like a word but is no effort is reported.
 */
export function splitTarget(text: string): { model: string; effort?: Effort; badEffort?: boolean } {
  const colon = text.lastIndexOf(":")
  if (colon === -1) return { model: text.trim() }
  const model = text.slice(0, colon).trim()
  const suffix = text.slice(colon + 1).trim().toLowerCase()
  if (suffix === "" || suffix === "default") return { model }
  if (isEffort(suffix)) return { model, effort: suffix }
  if (/^\d+$/.test(suffix)) return { model: text.trim() }
  return { model, badEffort: true }
}

type Options = Readonly<Record<string, unknown>>

function str(options: Options, key: string): string | undefined {
  const v = options[key]
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined
}

function numIn(options: Options, key: string, min: number, max: number, fallback: number, problems: string[]): number {
  const v = options[key]
  if (v === undefined || v === "") return fallback
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n < min || n > max) {
    problems.push(`${key} must be a number from ${min} to ${max}; using ${fallback}`)
    return fallback
  }
  return n
}

function oneOf<T extends string>(options: Options, key: string, allowed: readonly T[], fallback: T, problems: string[]): T {
  const v = str(options, key)
  if (v === undefined) return fallback
  if ((allowed as readonly string[]).includes(v)) return v as T
  problems.push(`${key} must be one of ${allowed.join(", ")}; using ${fallback}`)
  return fallback
}

function bool(options: Options, key: string, fallback: boolean): boolean {
  const v = options[key]
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return fallback
}

/**
 * Reads the optional advanced-settings file (`clef-model-router.json`): a
 * JSON object with the same keys as the plugin options. Plugin options win
 * over it; it wins over the defaults.
 */
export function parseAdvancedFile(text: string | undefined): { values: Options; problems: string[] } {
  if (text === undefined) return { values: {}, problems: [] }
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { values: {}, problems: ["clef-model-router.json must hold a JSON object; ignoring it"] }
    }
    const values = { ...(value as Record<string, unknown>) }
    // Credentials belong in the plugin's secure storage, not in a plain file.
    const problems: string[] = []
    if ("cloudflare_api_token" in values) {
      delete values.cloudflare_api_token
      problems.push("clef-model-router.json: cloudflare_api_token is ignored there; set it with /plugin configure")
    }
    return { values, problems }
  } catch {
    return { values: {}, problems: ["clef-model-router.json is not valid JSON; ignoring it"] }
  }
}

/**
 * Builds the Config from plugin options plus environment fallbacks for the
 * credentials (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN), which the
 * caller reads and passes in.
 */
export function parseConfig(
  options: Options,
  envFallback: { accountId?: string; apiToken?: string } = {},
): { config: Config; problems: string[] } {
  const problems: string[] = []
  const profiles = {} as Record<Level, ProfileSpec>
  // `profiles` is the five of them in one line, lowest first; a `profile_<level>`
  // key (in the advanced file) names one.
  const list = str(options, "profiles")?.split(",").map((s) => s.trim())
  if (list && list.length !== LEVELS.length) {
    problems.push(`profiles must list ${LEVELS.length} entries (${LEVELS.join(", ")}), got ${list.length}; using the defaults`)
  }
  for (const [i, level] of LEVELS.entries()) {
    const fromList = list && list.length === LEVELS.length ? list[i] : undefined
    const raw = str(options, `profile_${level}`) ?? fromList ?? DEFAULT_PROFILES[level]
    const parsed = parseProfile(level, raw)
    if (typeof parsed === "string") {
      problems.push(`${parsed}; using "${DEFAULT_PROFILES[level]}"`)
      profiles[level] = parseProfile(level, DEFAULT_PROFILES[level]) as ProfileSpec
    } else profiles[level] = parsed
  }
  const maxEffortRaw = str(options, "max_effort")
  let maxEffort: Effort | undefined
  if (maxEffortRaw !== undefined && maxEffortRaw !== "none") {
    if (isEffort(maxEffortRaw)) maxEffort = maxEffortRaw
    else problems.push(`max_effort must be one of ${EFFORTS.join(", ")} or none; ignoring it`)
  }

  const config: Config = {
    enabled: bool(options, "enabled", true),
    decisionModel: oneOf(options, "decision_model", CLEF_MODELS, DEFAULTS.decisionModel, problems),
    timeoutMs: numIn(options, "timeout_ms", 100, 10_000, DEFAULTS.timeoutMs, problems),
    profiles,
    confidenceThreshold: numIn(options, "confidence_threshold", 0, 1, DEFAULTS.confidenceThreshold, problems),
    lowConfidencePolicy: oneOf(options, "low_confidence_policy", LOW_CONFIDENCE_POLICIES, DEFAULTS.lowConfidencePolicy, problems),
    fallbackLevel: oneOf(options, "fallback_profile", LEVELS, DEFAULTS.fallbackLevel, problems),
    followUpThreshold: numIn(options, "follow_up_threshold", 0, 1, DEFAULTS.followUpThreshold, problems),
    cacheHoldMinTokens: numIn(options, "cache_hold_min_tokens", 0, 10_000_000, DEFAULTS.cacheHoldMinTokens, problems),
    cacheTtlMinutes: numIn(options, "cache_ttl_minutes", 0, 1440, DEFAULTS.cacheTtlMinutes, problems),
    dailyNeuronBudget: numIn(options, "daily_neuron_budget", 0, 1_000_000_000, DEFAULTS.dailyNeuronBudget, problems),
    maxPromptChars: numIn(options, "max_prompt_chars", 200, 200_000, DEFAULTS.maxPromptChars, problems),
    announce: oneOf(options, "announce", ANNOUNCE_MODES, DEFAULTS.announce, problems),
    pauseOnNativeChange: bool(options, "pause_on_native_change", true),
    logEnabled: bool(options, "log_enabled", true),
    logPrompts: bool(options, "log_prompts", false),
  }
  if (maxEffort) config.maxEffort = maxEffort
  const accountId = str(options, "cloudflare_account_id") ?? envFallback.accountId
  const apiToken = str(options, "cloudflare_api_token") ?? envFallback.apiToken
  if (accountId) config.accountId = accountId
  if (apiToken) config.apiToken = apiToken
  const logDir = str(options, "log_dir")
  if (logDir) config.logDir = logDir
  const rubricFile = str(options, "rubric_file")
  if (rubricFile) config.rubricFile = rubricFile
  return { config, problems }
}
