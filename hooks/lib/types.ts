// Shared types. Everything in hooks/lib is plain TypeScript with no engine
// dependency, so it runs under the mod engine and under `node --test` alike.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
export type Effort = (typeof EFFORTS)[number]

/** The five difficulty levels Clef scores, lowest first. Index = Clef level. */
export const LEVELS = ["trivial", "simple", "standard", "hard", "deep"] as const
export type Level = (typeof LEVELS)[number]

/** A profile as configured: what to run for one difficulty level. */
export type ProfileSpec = {
  level: Level
  /** An alias (`haiku`, `sonnet`, `opus`, `fable`) or a full model ID. */
  model: string
  /** Absent: keep the effort Claude Code would send (none on Haiku). */
  effort?: Effort
}

/** A route the router can apply to a request: a concrete model ID and effort. */
export type Route = {
  /** The profile it came from, when it came from one. */
  level?: Level
  model: string
  /** Absent: keep the effort Claude Code would send, clamped to the model. */
  effort?: Effort
}

/** An explicit choice: a profile, or a model, or only an effort. */
export type Target = { level?: Level; model?: string; effort?: Effort }

/**
 * What a decision provider returns, normalised. Nothing Cloudflare-specific
 * leaks past this type, so another backend (Jev, a local Clef) only has to
 * produce one of these.
 */
export type Recommendation = {
  /** e.g. "clef-flash", "clef". */
  provider: string
  level: Level
  /**
   * The probability the provider gave `level`, 0..1. This is what the
   * confidence threshold compares and what the status line shows.
   */
  confidence: number
  /**
   * The provider's own certainty figure, when it reports one. Clef's
   * `confidence` is not the top probability (it behaves like 1 - normalised
   * entropy: 76% on one level reads about 50%), so it is kept for analysis only.
   */
  providerConfidence?: number
  /** Probability per level; sums to ~1. */
  probabilities: Record<Level, number>
  /** Probability-weighted level (0..4), when the provider gives one. */
  score?: number
  /** P(the prompt is a follow-up whose task is defined by earlier turns). */
  contextDependent?: number
  latencyMs: number
  inputTokens?: number
}

export type FailureKind =
  | "not-configured"
  | "timeout"
  | "network"
  | "auth"
  | "quota"
  | "rate-limited"
  | "server"
  | "bad-request"
  | "malformed"
  | "budget"
  | "circuit-open"

export type ProviderFailure = {
  kind: FailureKind
  /** Short, already-redacted, safe to show and log. */
  message: string
  status?: number
  latencyMs: number
}

export type ProviderResult = { ok: true; recommendation: Recommendation } | { ok: false; failure: ProviderFailure }

export type DecisionProvider = {
  name: string
  decide: (prompt: string) => Promise<ProviderResult>
}

/** How a turn's text is classified before anything is asked. */
export type TurnKind = "prompt" | "go-ahead" | "notification" | "empty"

/** Where the final route came from. */
export type Source = "clef" | "override" | "pin" | "native" | "continuation" | "fallback" | "disabled"

/** One change policy made on the way to the final route. */
export type Adjustment = {
  rule:
    | "low-confidence"
    | "context-dependent"
    | "unavailable"
    | "context-window"
    | "cache-hold"
    | "effort-clamp"
    | "effort-cap"
    | "pinned-effort"
  from: string
  to: string
  reason: string
}

export type Decision = {
  turnId: string
  kind: TurnKind
  source: Source
  recommendation?: Recommendation
  failure?: ProviderFailure
  /** What Clef (or the override) asked for, before policy. */
  proposed?: Route
  /** What will be sent; undefined = leave the request as Claude Code made it. */
  final?: Route
  adjustments: Adjustment[]
  /** A human-readable reason when nothing is routed, or for a fallback. */
  note?: string
}
