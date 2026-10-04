// Deterministic gates in front of the Clef call: a local daily budget that
// keeps usage inside Workers AI's free allocation, a pause after the
// allocation is reported exhausted, and a circuit breaker so a dead endpoint
// costs one timeout, not one per prompt.
//
// The state is plain JSON kept in `$.store`, shared by every session on the
// machine (best effort: two sessions writing at once may lose a count).

import type { FailureKind, ProviderFailure } from "./types.ts"

export type GuardState = {
  /** UTC day (YYYY-MM-DD) the counters belong to. */
  day: string
  calls: number
  inputTokens: number
  /** Clef said the day's free allocation is used up; no calls until `day` changes. */
  quotaExhausted?: boolean
  consecutiveFailures: number
  /** Epoch ms until which no call is made. */
  pausedUntil?: number
  pauseReason?: FailureKind
}

/**
 * Neurons per million input tokens, derived from Cloudflare's published
 * prices ($0.09/M for clef-flash, $0.24/M for clef) at $0.011 per 1,000
 * neurons. Clef is not yet in the per-model neuron table; this is an
 * estimate, and the Workers AI dashboard is the authority.
 */
export const NEURONS_PER_M_INPUT: Record<string, number> = {
  "clef-flash": (0.09 / 0.011) * 1000,
  clef: (0.24 / 0.011) * 1000,
}

export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

export function freshGuard(epochMs: number): GuardState {
  return { day: utcDay(epochMs), calls: 0, inputTokens: 0, consecutiveFailures: 0 }
}

/** Rolls the counters over at 00:00 UTC, when Workers AI's allocation resets. */
export function normaliseGuard(state: unknown, epochMs: number): GuardState {
  const today = utcDay(epochMs)
  if (typeof state !== "object" || state === null) return freshGuard(epochMs)
  const s = state as Partial<GuardState>
  if (s.day !== today) {
    const next = freshGuard(epochMs)
    if (typeof s.pausedUntil === "number" && s.pausedUntil > epochMs && s.pauseReason !== "quota") {
      next.pausedUntil = s.pausedUntil
      next.pauseReason = s.pauseReason
    }
    return next
  }
  return {
    day: today,
    calls: typeof s.calls === "number" ? s.calls : 0,
    inputTokens: typeof s.inputTokens === "number" ? s.inputTokens : 0,
    consecutiveFailures: typeof s.consecutiveFailures === "number" ? s.consecutiveFailures : 0,
    ...(s.quotaExhausted ? { quotaExhausted: true } : {}),
    ...(typeof s.pausedUntil === "number" ? { pausedUntil: s.pausedUntil } : {}),
    ...(s.pauseReason ? { pauseReason: s.pauseReason } : {}),
  }
}

export function estimatedNeurons(state: GuardState, model: string): number {
  return (state.inputTokens / 1_000_000) * (NEURONS_PER_M_INPUT[model] ?? NEURONS_PER_M_INPUT.clef!)
}

/** Why no call should be made now, or undefined to go ahead. */
export function blockedReason(
  state: GuardState,
  opts: { now: number; model: string; dailyNeuronBudget: number },
): ProviderFailure | undefined {
  if (state.quotaExhausted) {
    return { kind: "quota", message: "Workers AI daily free allocation used up; resets 00:00 UTC", latencyMs: 0 }
  }
  if (opts.dailyNeuronBudget > 0 && estimatedNeurons(state, opts.model) >= opts.dailyNeuronBudget) {
    return {
      kind: "budget",
      message: `local daily budget of ${opts.dailyNeuronBudget} neurons reached; resets 00:00 UTC`,
      latencyMs: 0,
    }
  }
  if (state.pausedUntil !== undefined && state.pausedUntil > opts.now) {
    const seconds = Math.ceil((state.pausedUntil - opts.now) / 1000)
    return {
      kind: "circuit-open",
      message: `paused ${seconds}s after ${state.pauseReason ?? "repeated failures"}`,
      latencyMs: 0,
    }
  }
  return undefined
}

/** How long to stop calling after a failure, in ms; 0 for none. */
export const PAUSES = {
  /** After this many failures in a row, stop calling for a while. */
  breakerThreshold: 3,
  breakerMs: 5 * 60_000,
  rateLimitedMs: 60_000,
  /** Auth and request errors need the user to fix configuration. */
  configMs: 30 * 60_000,
}

export function recordSuccess(state: GuardState, inputTokens: number | undefined): GuardState {
  const next: GuardState = {
    ...state,
    calls: state.calls + 1,
    inputTokens: state.inputTokens + (inputTokens ?? 0),
    consecutiveFailures: 0,
  }
  delete next.pausedUntil
  delete next.pauseReason
  return next
}

export function recordFailure(state: GuardState, failure: ProviderFailure, now: number): GuardState {
  // Failures that never reached Cloudflare count toward nothing.
  if (failure.kind === "not-configured" || failure.kind === "budget" || failure.kind === "circuit-open") return state
  const next: GuardState = { ...state, calls: state.calls + 1, consecutiveFailures: state.consecutiveFailures + 1 }
  if (failure.kind === "quota") return { ...next, quotaExhausted: true }
  let pause = 0
  if (failure.kind === "rate-limited") pause = PAUSES.rateLimitedMs
  else if (failure.kind === "auth" || failure.kind === "bad-request") pause = PAUSES.configMs
  else if (next.consecutiveFailures >= PAUSES.breakerThreshold) pause = PAUSES.breakerMs
  if (pause > 0) return { ...next, pausedUntil: now + pause, pauseReason: failure.kind }
  return next
}
