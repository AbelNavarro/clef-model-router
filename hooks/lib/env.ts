// Turns the environment variables Claude Code itself honours into the facts
// the policy needs. Pure: the hooks module reads the variables (by literal
// name, as the engine requires) and passes them here.

import type { ModelEnv } from "./models.ts"

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

/**
 * The main conversation's prompt-cache TTL, resolved in the order Claude
 * Code's prompt-caching docs give: FORCE_PROMPT_CACHING_5M, the TTL variable,
 * the `promptCacheTtl` setting, ENABLE_PROMPT_CACHING_1H, then the default
 * (one hour on a subscription, five minutes with an API key or a cloud
 * provider). A subscription past its included usage drops to five minutes,
 * which this cannot see; it then over-estimates warmth, which only makes the
 * router hold a model it could have left.
 */
export function cacheTtlMs(configMinutes: number, env: EnvValues, settingsTtl?: unknown): number {
  if (configMinutes > 0) return configMinutes * 60_000
  if (truthy(env.FORCE_PROMPT_CACHING_5M)) return FIVE_MIN
  const fromEnv = ttlValue(env.CLAUDE_CODE_PROMPT_CACHE_TTL)
  if (fromEnv) return fromEnv
  const fromSettings = typeof settingsTtl === "string" ? ttlValue(settingsTtl) : undefined
  if (fromSettings) return fromSettings
  if (truthy(env.ENABLE_PROMPT_CACHING_1H)) return ONE_HOUR
  const viaKeyOrCloud = !!env.ANTHROPIC_API_KEY || modelEnvFrom(env).thirdParty
  return viaKeyOrCloud ? FIVE_MIN : ONE_HOUR
}
