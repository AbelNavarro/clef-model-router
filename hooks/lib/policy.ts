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
//   9. A downgrade off a warm prompt cache → held until staying has cost what
//      switching costs, in the unit the person's billing makes scarce
//      (docs/adr/0001-downgrade-timing-by-billing-mode.md)
//  10. Effort is capped and clamped to what the model takes

import type { Config } from "./config.ts"
import {
  capEffort,
  clampEffort,
  displayName,
  effortChangeKeepsCache,
  effortsFor,
  rankOf,
  resolveModel,
  sameModel,
  windowOf,
  type ModelEnv,
} from "./models.ts"
import { dollars, isOneHour, priceOf, switchCost, type Billing } from "./pricing.ts"
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
  /**
   * Whether the API reported any cache read or write for it. False where
   * nothing is cached (a gateway that strips cache markers): there is then no
   * cache to keep. Absent in state saved by earlier versions: assumed true.
   */
  caching?: boolean
}

/** A stretch of held downgrades: what staying on the warm model has cost so far. */
export type HoldState = {
  /** The model held, whose cache is warm. */
  model: string
  /** What Clef's level asked for on the last held turn; a continuation weighs it again. */
  wanted: Route
  /** List-price dollars staying has cost over the stretch's completed turns. */
  spent: number
  turns: number
}

export type PolicySession = {
  mode: RouterMode
  pin?: Target
  last?: Route
  cache?: CacheState
  hold?: HoldState
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
  /** How the person pays: what a held downgrade costs them. */
  billing: Billing
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
export function needsClef(input: Omit<PolicyInput, "result" | "now" | "cacheTtlMs" | "contextTokens" | "billing">): boolean {
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

/**
 * The effort a turn held on its warm model runs at. Where an effort change
 * keeps the cache, it still comes down to what Clef's level asked for, and a
 * level whose model takes no effort (Haiku) gets the held model's lowest: the
 * turn is held for the cache, not for more thinking. Elsewhere the cached
 * effort stays, since changing it would cost the cache the hold is keeping.
 */
function heldEffort(route: Route, cache: CacheState, env: ModelEnv): Effort | undefined {
  if (!effortChangeKeepsCache(cache.model, env)) return cache.effort
  if (route.effort) return route.effort
  if (effortsFor(route.model) === null) return effortsFor(cache.model)?.[0] ?? "low"
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
    // 3. Continuation. One that continues a held turn weighs the deferred
    // downgrade again (step 9), so a run of go-aheads cannot outlast it.
    source = "continuation"
    const hold = session.hold && sameModel(session.last.model, session.hold.model) ? session.hold : undefined
    route = { ...(hold ? hold.wanted : session.last) }
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

  // 9. A downgrade off a warm cache, for routes the router chose itself. Each
  // model has its own prompt cache, so moving a conversation writes all of it
  // again. That pays off over a stretch of cheaper turns, not over one: the
  // downgrade is held while what staying has cost so far is less than what the
  // switch costs now (times downgrade_patience), then taken. Short dips stay
  // put; long stretches move. What "cost" means depends on the billing.
  const cache = session.cache
  const warm = cache !== undefined && input.now - cache.at < input.cacheTtlMs
  if ((source === "clef" || source === "continuation") && cache && warm && cache.caching !== false && !isUnavailable(cache.model, session)) {
    const fromRank = rankOf(cache.model)
    const toRank = rankOf(route.model)
    const modelDown = fromRank !== undefined && toRank !== undefined && toRank < fromRank
    const effortDown =
      !modelDown &&
      sameModel(route.model, cache.model) &&
      route.effort !== undefined &&
      cache.effort !== undefined &&
      EFFORTS.indexOf(route.effort) < EFFORTS.indexOf(cache.effort) &&
      !effortChangeKeepsCache(cache.model, input.modelEnv)
    // An effort change that breaks the cache rewrites it on the same model.
    const toPrice = priceOf(modelDown ? route.model : cache.model)
    if ((modelDown || effortDown) && toPrice) {
      const tokens = input.contextTokens ?? cache.promptTokens
      const cost = switchCost(toPrice, tokens, isOneHour(input.cacheTtlMs))
      const prior = session.hold && sameModel(session.hold.model, cache.model) ? session.hold : undefined
      const spent = prior?.spent ?? 0
      const turns = prior?.turns ?? 0
      const wanted: Route = { ...route }
      const billing = input.billing
      if (spent >= cost * config.downgradePatience) {
        if (prior) decision.deferral = { wanted, from: cache.model, billing, spent, cost, turns, held: false }
      } else {
        const held: Route = { model: cache.model }
        if (route.level) held.level = route.level
        const effort = modelDown ? heldEffort(route, cache, input.modelEnv) : cache.effort
        if (effort) held.effort = effort
        const sofar = `staying has cost ${dollars(spent)} so far (${billing}, list prices)`
        adjustments.push({
          rule: "cache-hold",
          from: describe(route),
          to: describe(held),
          reason: modelDown
            ? `${kTokens(tokens)} context is cached on ${displayName(cache.model)}; moving to ${displayName(route.model)} writes it again (${dollars(cost)}); ${sofar}`
            : `changing effort on ${displayName(cache.model)} here rewrites its ${kTokens(tokens)} cached context (${dollars(cost)}); ${sofar}`,
        })
        decision.deferral = { wanted, from: cache.model, billing, spent, cost, turns: turns + 1, held: true }
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

  const out: Decision = { ...decision, source, final: route, billing: input.billing }
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
