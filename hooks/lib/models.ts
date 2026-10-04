// What this router knows about Claude models: how an alias resolves, which
// effort levels a model takes, how big its window is, and how it ranks.
//
// Source: Claude Code model configuration docs (Claude Code 2.1.289,
// October 2026). `turn.step` does not resolve aliases (a request for
// "haiku" fails with unrecognized_model), so every route is resolved here to
// a full ID before it is sent.

import { EFFORTS, type Effort } from "./types.ts"

export type Family = "haiku" | "sonnet" | "opus" | "fable"

/** What each alias resolves to on the Anthropic API, as Claude Code does. */
export const FIRST_PARTY_ALIASES: Record<Family, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
}

/**
 * The environment the resolution depends on: Claude Code's own
 * ANTHROPIC_DEFAULT_*_MODEL pins, and whether a third-party provider is in use
 * (where first-party IDs do not exist).
 */
export type ModelEnv = {
  defaults: Partial<Record<Family, string>>
  thirdParty: boolean
  /** Prompt-cache beta features off (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS). */
  betasDisabled: boolean
}

export const FIRST_PARTY_ENV: ModelEnv = { defaults: {}, thirdParty: false, betasDisabled: false }

export function isAlias(model: string): model is Family {
  return model === "haiku" || model === "sonnet" || model === "opus" || model === "fable"
}

/** Resolves an alias or ID to a concrete model ID, or undefined if it cannot be. */
export function resolveModel(model: string, env: ModelEnv): string | undefined {
  const m = model.trim()
  if (m === "") return undefined
  if (!isAlias(m)) return m
  const pinned = env.defaults[m]
  if (pinned) return pinned
  // On Bedrock, Vertex or Foundry, a first-party ID would fail.
  return env.thirdParty ? undefined : FIRST_PARTY_ALIASES[m]
}

export function familyOf(modelId: string): Family | undefined {
  const id = modelId.toLowerCase()
  if (id.includes("haiku")) return "haiku"
  if (id.includes("sonnet")) return "sonnet"
  if (id.includes("fable")) return "fable"
  if (id.includes("opus")) return "opus"
  return undefined
}

const RANK: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

/** Capability/price rank for comparing two models; undefined if unknown. */
export function rankOf(modelId: string): number | undefined {
  const f = familyOf(modelId)
  return f === undefined ? undefined : RANK[f]
}

/** Display name for the status line: "Sonnet", "Opus", or the raw ID. */
export function displayName(modelId: string): string {
  const f = familyOf(modelId)
  return f === undefined ? modelId : f[0]!.toUpperCase() + f.slice(1)
}

/**
 * The effort levels a model accepts; null when it takes no effort at all,
 * undefined when the model is unknown (send what was asked; Claude Code
 * clamps it).
 */
export function effortsFor(modelId: string): readonly Effort[] | null | undefined {
  const id = modelId.toLowerCase()
  if (id.includes("haiku")) return null
  if (/(opus|sonnet)-4-6/.test(id)) return ["low", "medium", "high", "max"]
  if (/fable|opus-5|sonnet-5|opus-4-[78]/.test(id)) return EFFORTS
  return undefined
}

/**
 * The highest supported level at or below the one asked, which is what
 * Claude Code itself does; undefined when the model takes no effort.
 */
export function clampEffort(modelId: string, effort: Effort | undefined): Effort | undefined {
  if (effort === undefined) return undefined
  const supported = effortsFor(modelId)
  if (supported === null) return undefined
  if (supported === undefined) return effort
  for (let i = EFFORTS.indexOf(effort); i >= 0; i--) {
    const level = EFFORTS[i]!
    if (supported.includes(level)) return level
  }
  return supported[0]
}

export function capEffort(effort: Effort | undefined, cap: Effort | undefined): Effort | undefined {
  if (effort === undefined || cap === undefined) return effort
  return EFFORTS.indexOf(effort) > EFFORTS.indexOf(cap) ? cap : effort
}

/** Context window in tokens where it is known to be smaller than 1M. */
export function windowOf(modelId: string): number | undefined {
  const id = modelId.toLowerCase()
  if (id.includes("haiku")) return 200_000
  return undefined
}

/**
 * Whether changing effort between requests keeps the prompt cache. Per the
 * Claude Code prompt-caching docs, it does on Opus 5.5, Sonnet 5.5 and
 * Fable 5.1 with an API key or subscription, and not on Bedrock, Vertex, a
 * gateway, or with experimental betas disabled. Elsewhere it is a full miss.
 */
export function effortChangeKeepsCache(modelId: string, env: ModelEnv): boolean {
  if (env.thirdParty || env.betasDisabled) return false
  return /claude-(opus|sonnet)-5-5|claude-fable-5-1/.test(modelId.toLowerCase())
}

/** Compares IDs ignoring a date suffix and a [1m] marker. */
export function sameModel(a: string, b: string): boolean {
  const norm = (id: string) => id.toLowerCase().replace(/\[1m\]$/, "").replace(/-\d{8}$/, "")
  return norm(a) === norm(b)
}

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value)
}
