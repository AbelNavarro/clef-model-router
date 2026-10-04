// The routing policy: a pure function from what is known at the start of a
// turn to the route its requests will use, with every change it made on the
// way recorded. Clef makes the semantic judgment (how hard is this?); this
// file makes the deterministic ones (what is allowed, what is safe, what is
// worth the cache), in this order:
//
//   1. Routing off (config, +off; /clef off and a mid-session /model change, unless +model/+profile)
//   2. An explicit choice: a +target prefix this turn, then a /clef pin
//   3. A continuation (go-ahead, task notification, empty) reuses the last route
//   4. Clef's recommendation, or the fallback when Clef did not answer
//   5. Low confidence → the configured confidence policy
//   6. A follow-up never routes below the route it follows
//   7. A profile whose model is unavailable → the nearest available one, upward first
//   8. A context too big for the model's window → the nearest profile that fits
//   9. A downgrade that would throw away a large warm prompt cache → hold the model
//  10. Effort is capped and clamped to what the model takes

import type { Config } from "./config.ts"
import {
  capEffort,
  clampEffort,
  displayName,
  effortChangeKeepsCache,
  rankOf,
  resolveModel,
  sameModel,
  windowOf,
  type ModelEnv,
} from "./models.ts"
import {
  EFFORTS,
  LEVELS,
  type Adjustment,
  type Decision,
  type Effort,
  type Level,
  type ProviderResult,
  type Route,
  type Source,
  type Target,
  type TurnKind,
} from "./types.ts"

export type RouterMode = "auto" | "off" | "paused-native"

/** The last request the main loop sent, which is what the prompt cache holds. */
export type CacheState = {
  model: string
  effort?: Effort
  /** Epoch ms the response finished. */
  at: number
  /** Input + cache read + cache write tokens of that request. */
  promptTokens: number
}

export type PolicySession = {
  mode: RouterMode
  pin?: Target
  last?: Route
  cache?: CacheState
  /** Models that failed when routed to this session. */
  unavailable: readonly string[]
}

export type PolicyInput = {
  turnId: string
  kind: TurnKind
  config: Config
  modelEnv: ModelEnv
  session: PolicySession
  /** A one-turn +target prefix; "off" leaves this turn alone. */
  override?: Target | "off"
  /** Clef's answer; absent when Clef was not asked. */
  result?: ProviderResult
  /** Tokens in the conversation now, when known. */
  contextTokens?: number
  now: number
  cacheTtlMs: number
}

/** Headroom kept under a model's window for the reply and tool results. */
export const WINDOW_HEADROOM = 20_000

const idx = (level: Level) => LEVELS.indexOf(level)
const atIdx = (i: number): Level => LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i))]!
const higher = (a: Level, b: Level): Level => (idx(a) >= idx(b) ? a : b)

export function describe(route: Route | undefined): string {
  if (!route) return "session default"
  return route.effort ? `${displayName(route.model)} · ${route.effort}` : displayName(route.model)
}

/**
 * Whether the policy should ask Clef at all for this turn. Explicit choices,
 * continuations and a disabled router make no network call.
 */
export function needsClef(input: Omit<PolicyInput, "result" | "now" | "cacheTtlMs" | "contextTokens">): boolean {
  const { config, session, override, kind } = input
  if (!config.enabled || override === "off") return false
  if (override && (override.level || override.model)) return false
  if (session.mode !== "auto") return false
  if (session.pin && (session.pin.level || session.pin.model)) return false
  if (kind !== "prompt" && session.last) return false
  if ((kind === "notification" || kind === "empty") && !session.last) return false
  return true
}

function isUnavailable(model: string, session: PolicySession): boolean {
  return session.unavailable.some((u) => sameModel(u, model))
}

/** The route for a profile, or the nearest usable profile (upward first). */
function routeForLevel(
  level: Level,
  input: PolicyInput,
  adjustments: Adjustment[],
): Route | undefined {
  const order = [idx(level), ...LEVELS.map((_, i) => i).filter((i) => i > idx(level)), ...LEVELS.map((_, i) => i).filter((i) => i < idx(level)).reverse()]
  for (const i of order) {
    const lv = atIdx(i)
    const spec = input.config.profiles[lv]
    const model = resolveModel(spec.model, input.modelEnv)
    if (model === undefined || isUnavailable(model, input.session)) continue
    const route: Route = { level: lv, model }
    if (spec.effort) route.effort = spec.effort
    if (lv !== level) {
      adjustments.push({
        rule: "unavailable",
        from: level,
        to: lv,
        reason: `profile ${level} (${input.config.profiles[level].model}) has no usable model here`,
      })
    }
    return route
  }
  return undefined
}

function routeForTarget(target: Target, input: PolicyInput, adjustments: Adjustment[]): Route | undefined {
  if (target.level) {
    const route = routeForLevel(target.level, input, adjustments)
    if (route && target.effort) route.effort = target.effort
    return route
  }
  if (target.model) {
    const model = resolveModel(target.model, input.modelEnv)
    if (model === undefined) return undefined
    return target.effort ? { model, effort: target.effort } : { model }
  }
  return undefined
}

/** The more capable of the two most probable levels. */
function upperOfTopTwo(probabilities: Record<Level, number>, top: Level): Level {
  let second: Level | undefined
  for (const level of LEVELS) {
    if (level === top) continue
    if (second === undefined || probabilities[level] >= probabilities[second]) second = level
  }
  return second === undefined ? top : higher(top, second)
}

export function decide(input: PolicyInput): Decision {
  const { config, session, turnId, kind } = input
  const adjustments: Adjustment[] = []
  const base = { turnId, kind, adjustments }
  const disabled = (source: Source, note: string): Decision => ({ ...base, source, note })

  // 1. Off. A one-turn +model or +profile still applies while the session is
  // off or paused: it is the most explicit request there is.
  if (!config.enabled) return disabled("disabled", "routing disabled in plugin config")
  if (input.override === "off") return disabled("disabled", "+off: this turn runs as Claude Code would")
  const explicitTurn = input.override !== undefined && (input.override.level !== undefined || input.override.model !== undefined)
  if (session.mode === "off" && !explicitTurn) return disabled("disabled", "routing off for this session (/clef on)")
  if (session.mode === "paused-native" && !explicitTurn)
    return disabled("native", "paused: you changed /model (/clef auto to resume)")

  let source: Source
  let route: Route | undefined
  let proposed: Route | undefined
  let note: string | undefined
  const decision: Decision = { ...base, source: "clef" }

  // 2. Explicit choice.
  const explicit = input.override ?? (session.mode === "auto" ? session.pin : undefined)
  const explicitSource: Source = input.override ? "override" : "pin"
  if (explicit && (explicit.level || explicit.model)) {
    source = explicitSource
    route = routeForTarget(explicit, input, adjustments)
    if (!route) return disabled(explicitSource, `cannot resolve ${explicit.model ?? explicit.level} here`)
    proposed = { ...route }
  } else if (kind !== "prompt" && session.last) {
    // 3. Continuation.
    source = "continuation"
    route = { ...session.last }
    proposed = { ...route }
    note = kind === "go-ahead" ? "go-ahead continues the last route" : `${kind} continues the last route`
  } else if ((kind === "notification" || kind === "empty") && !session.last) {
    return disabled("continuation", "nothing to continue yet")
  } else {
    // 4. Clef, or the fallback.
    const result = input.result
    let level: Level
    if (result?.ok) {
      source = "clef"
      const rec = result.recommendation
      decision.recommendation = rec
      level = rec.level
      proposed = routeForLevel(level, input, [])

      // 5. Low confidence.
      if (rec.confidence < config.confidenceThreshold) {
        let adjusted: Level = level
        switch (config.lowConfidencePolicy) {
          case "upper-of-top-two":
            adjusted = upperOfTopTwo(rec.probabilities, level)
            break
          case "bump":
            adjusted = atIdx(idx(level) + 1)
            break
          case "hold":
            adjusted = session.last?.level ?? config.fallbackLevel
            break
          case "fallback":
            adjusted = config.fallbackLevel
            break
          case "obey":
            break
        }
        if (adjusted !== level) {
          adjustments.push({
            rule: "low-confidence",
            from: level,
            to: adjusted,
            reason: `confidence ${pct(rec.confidence)} < ${pct(config.confidenceThreshold)} (${config.lowConfidencePolicy})`,
          })
          level = adjusted
        }
      }

      // 6. Follow-up floor.
      const lastLevel = session.last?.level
      if (
        rec.contextDependent !== undefined &&
        rec.contextDependent >= config.followUpThreshold &&
        lastLevel !== undefined &&
        idx(lastLevel) > idx(level)
      ) {
        adjustments.push({
          rule: "context-dependent",
          from: level,
          to: lastLevel,
          reason: `follow-up (${pct(rec.contextDependent)}) to a ${lastLevel} turn`,
        })
        level = lastLevel
      }
    } else {
      source = "fallback"
      if (result && !result.ok) decision.failure = result.failure
      const lastLevel = session.last?.level
      level = lastLevel ? higher(lastLevel, config.fallbackLevel) : config.fallbackLevel
      note = `${result && !result.ok ? result.failure.kind : "no answer"}: using ${level}`
    }

    // 7. Availability.
    route = routeForLevel(level, input, adjustments)
    if (!route) return { ...decision, ...disabled(source, "no configured profile resolves to a usable model here") }
    if (source === "fallback") proposed = { ...route }
  }

  // 8. Context window.
  const tokens = input.contextTokens ?? session.cache?.promptTokens
  if (tokens !== undefined) {
    const fits = (model: string) => {
      const w = windowOf(model)
      return w === undefined || tokens + WINDOW_HEADROOM <= w
    }
    if (!fits(route.model)) {
      const start = route.level ? idx(route.level) : 0
      let moved: Route | undefined
      for (let i = start + 1; i < LEVELS.length && !moved; i++) {
        const candidate = routeForLevel(atIdx(i), input, [])
        if (candidate && fits(candidate.model)) moved = candidate
      }
      if (moved) {
        adjustments.push({
          rule: "context-window",
          from: describe(route),
          to: describe(moved),
          reason: `${kTokens(tokens)} context does not fit ${displayName(route.model)}'s window`,
        })
        route = moved
      }
    }
  }

  // 9. Cache hold: only for routes the router chose itself.
  const cache = session.cache
  if ((source === "clef" || source === "continuation") && cache && config.cacheHoldMinTokens > 0) {
    const warm = input.now - cache.at < input.cacheTtlMs
    const big = cache.promptTokens >= config.cacheHoldMinTokens
    const fromRank = rankOf(cache.model)
    const toRank = rankOf(route.model)
    if (warm && big && !isUnavailable(cache.model, session)) {
      const ago = Math.round((input.now - cache.at) / 1000)
      if (fromRank !== undefined && toRank !== undefined && toRank < fromRank) {
        const keepsCache = effortChangeKeepsCache(cache.model, input.modelEnv)
        const held: Route = { model: cache.model }
        if (route.level) held.level = route.level
        const effort = keepsCache ? (route.effort ?? cache.effort) : cache.effort
        if (effort) held.effort = effort
        adjustments.push({
          rule: "cache-hold",
          from: describe(route),
          to: describe(held),
          reason: `${kTokens(cache.promptTokens)} context is cached on ${displayName(cache.model)} (${ago}s ago); ${displayName(route.model)} would re-read it uncached`,
        })
        route = held
      } else if (
        sameModel(route.model, cache.model) &&
        route.effort &&
        cache.effort &&
        EFFORTS.indexOf(route.effort) < EFFORTS.indexOf(cache.effort) &&
        !effortChangeKeepsCache(cache.model, input.modelEnv)
      ) {
        const held: Route = { ...route, effort: cache.effort }
        adjustments.push({
          rule: "cache-hold",
          from: describe(route),
          to: describe(held),
          reason: `changing effort on ${displayName(cache.model)} here invalidates the ${kTokens(cache.promptTokens)} cached context`,
        })
        route = held
      }
    }
  }

  // An effort-only pin applies to whatever model was chosen.
  if (session.pin?.effort && !session.pin.level && !session.pin.model && !(input.override && input.override.effort)) {
    if (route.effort !== session.pin.effort) {
      adjustments.push({ rule: "pinned-effort", from: route.effort ?? "default", to: session.pin.effort, reason: "/clef pin" })
      route = { ...route, effort: session.pin.effort }
    }
  }
  if (input.override && !input.override.level && !input.override.model && input.override.effort) {
    adjustments.push({ rule: "pinned-effort", from: route.effort ?? "default", to: input.override.effort, reason: "+ prefix" })
    route = { ...route, effort: input.override.effort }
  }

  // 10. Effort cap and clamp.
  if (route.effort) {
    const capped = capEffort(route.effort, config.maxEffort)
    if (capped !== route.effort) {
      adjustments.push({ rule: "effort-cap", from: route.effort, to: capped ?? "none", reason: `max_effort is ${config.maxEffort}` })
    }
    const clamped = clampEffort(route.model, capped)
    if (clamped !== capped) {
      adjustments.push({
        rule: "effort-clamp",
        from: capped ?? "none",
        to: clamped ?? "none",
        reason: `${displayName(route.model)} ${clamped ? `tops out at ${clamped}` : "takes no effort setting"}`,
      })
    }
    route = { ...route }
    if (clamped) route.effort = clamped
    else delete route.effort
  }

  const out: Decision = { ...decision, source, final: route }
  if (proposed) out.proposed = proposed
  if (note) out.note = note
  return out
}

export function pct(p: number): string {
  return `${Math.round(p * 100)}%`
}

export function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** Whether policy changed what Clef (or the override) proposed. */
export function wasAdjusted(decision: Decision): boolean {
  return decision.adjustments.length > 0
}
