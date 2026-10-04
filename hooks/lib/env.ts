// Turns the environment variables Claude Code itself honours into the facts
// the policy needs. Pure: the hooks module reads the variables (by literal
// name, as the engine requires) and passes them here.

import type { ModelEnv } from "./models.ts"
import type { Billing } from "./pricing.ts"

export type EnvValues = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string
  ANTHROPIC_DEFAULT_FABLE_MODEL?: string
  CLAUDE_CODE_USE_BEDROCK?: string
  CLAUDE_CODE_USE_VERTEX?: string
  CLAUDE_CODE_USE_FOUNDRY?: string
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS?: string
  ANTHROPIC_API_KEY?: string
  CLAUDE_CODE_PROMPT_CACHE_TTL?: string
  FORCE_PROMPT_CACHING_5M?: string
  ENABLE_PROMPT_CACHING_1H?: string
  ANTHROPIC_AUTH_TOKEN?: string
  ANTHROPIC_BASE_URL?: string
}

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"

export function modelEnvFrom(env: EnvValues): ModelEnv {
  const defaults: ModelEnv["defaults"] = {}
  if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) defaults.haiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) defaults.sonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL
  if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) defaults.opus = env.ANTHROPIC_DEFAULT_OPUS_MODEL
  if (env.ANTHROPIC_DEFAULT_FABLE_MODEL) defaults.fable = env.ANTHROPIC_DEFAULT_FABLE_MODEL
  return {
    defaults,
    thirdParty: truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX) || truthy(env.CLAUDE_CODE_USE_FOUNDRY),
    betasDisabled: truthy(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS),
  }
}

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000

function ttlValue(v: string | undefined): number | undefined {
  if (v === "5m") return FIVE_MIN
  if (v === "1h") return ONE_HOUR
  return undefined
}

/** One rate-limit window as `$.session.usage()` reports it. */
export type RateLimitWindow = { kind: string; percentUsed: number }

/** What the session shows about how the person pays for Claude. */
export type BillingFacts = {
  billing: Billing
  /** Why, in a few words, for /clef. */
  why: string
  /** A subscription past its included usage, drawing usage credits billed per token. */
  overage: boolean
}

/** The windows a Claude subscription reports; an API key or cloud provider reports none. */
const PLAN_WINDOWS = ["five_hour", "seven_day"]

/**
 * How the person pays, from the strongest evidence available:
 *
 * 1. The plan's rate-limit windows (`five_hour`, `seven_day`), which Claude
 *    Code reports only on a subscription. One at 100% or more means the plan's
 *    included usage is spent and further requests are usage credits, billed
 *    per token like the API.
 * 2. A gateway's `spend_limit` window: billed per token.
 * 3. The environment: a cloud provider, an API key (or `apiKeyHelper`), or a
 *    gateway (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`) bill per token.
 *    Nothing set means a claude.ai login, which is a subscription.
 *
 * The windows are empty until the session's first response, so the first
 * turn is judged on the environment alone.
 */
export function detectBilling(
  env: EnvValues,
  opts: { apiKeyHelper?: boolean; rateLimits?: readonly RateLimitWindow[] } = {},
): BillingFacts {
  const windows = opts.rateLimits ?? []
  const plan = windows.filter((w) => PLAN_WINDOWS.includes(w.kind))
  if (plan.length > 0) {
    if (plan.some((w) => w.percentUsed >= 100)) return { billing: "api", why: "plan limit reached: usage credits bill per token", overage: true }
    return { billing: "subscription", why: "the plan's rate limits are reported", overage: false }
  }
  if (windows.some((w) => w.kind === "spend_limit")) return { billing: "api", why: "a gateway spend limit is reported", overage: false }
  if (modelEnvFrom(env).thirdParty) return { billing: "api", why: "a cloud provider bills per token", overage: false }
  if (env.ANTHROPIC_API_KEY || opts.apiKeyHelper) return { billing: "api", why: "an API key is set", overage: false }
  if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) return { billing: "api", why: "a gateway is set (ANTHROPIC_BASE_URL)", overage: false }
  return { billing: "subscription", why: "no API key, provider or gateway is set", overage: false }
}

/**
 * The main conversation's prompt-cache TTL, resolved in the order Claude
 * Code's prompt-caching docs give: FORCE_PROMPT_CACHING_5M, the TTL variable,
 * the `promptCacheTtl` setting, ENABLE_PROMPT_CACHING_1H, then the default:
 * one hour on a subscription within its included usage, five minutes
 * otherwise (an API key, a cloud provider, usage credits). The default follows
 * what was detected, not the `billing` option: the option says what the
 * person wants optimised, the TTL is what Claude Code actually requests.
 */
export function cacheTtlMs(configMinutes: number, env: EnvValues, settingsTtl?: unknown, detected: BillingFacts = detectBilling(env)): number {
  if (configMinutes > 0) return configMinutes * 60_000
  if (truthy(env.FORCE_PROMPT_CACHING_5M)) return FIVE_MIN
  const fromEnv = ttlValue(env.CLAUDE_CODE_PROMPT_CACHE_TTL)
  if (fromEnv) return fromEnv
  const fromSettings = typeof settingsTtl === "string" ? ttlValue(settingsTtl) : undefined
  if (fromSettings) return fromSettings
  if (truthy(env.ENABLE_PROMPT_CACHING_1H)) return ONE_HOUR
  return detected.billing === "subscription" ? ONE_HOUR : FIVE_MIN
}
