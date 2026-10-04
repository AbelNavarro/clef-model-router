// What a turn costs, and what a model switch costs, in list-price dollars.
//
// These figures are a yardstick for comparing staying on a model with leaving
// it, not a bill: cloud providers price differently (regional endpoints cost
// 10% more), negotiated rates differ, and a subscription does not bill per
// token at all. What matters to the policy is the ratio between the two sides,
// which holds wherever the price list is proportional to Anthropic's. See
// docs/COSTS.md and docs/adr/0001-downgrade-timing-by-billing-mode.md.
//
// Source: Anthropic API pricing (platform.claude.com/docs/en/about-claude/pricing),
// October 2026. Prices are dollars per million tokens.

import { familyOf, type Family } from "./models.ts"

/** How the person pays for Claude, which decides what a held turn costs them. */
export const BILLINGS = ["subscription", "api"] as const
export type Billing = (typeof BILLINGS)[number]

export type Price = {
  input: number
  write5m: number
  write1h: number
  /** Cache hits and refreshes. */
  read: number
  output: number
}

/** Cache writes are 1.25× input (5 minutes) or 2× (1 hour); the read multiplier varies by model. */
const price = (input: number, read: number, output: number): Price => ({ input, write5m: input * 1.25, write1h: input * 2, read, output })

// Most specific first: "opus-5-5" before "opus-5", "opus-4-5" before "opus-4".
const TABLE: readonly [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, price(10, 0.25, 50)],
  [/(fable|mythos)-5/, price(10, 1, 50)],
  [/opus-5-5/, price(4, 0.2, 20)],
  [/opus-(5|4-[5-8])/, price(5, 0.5, 25)],
  [/opus-4/, price(15, 1.5, 75)],
  [/sonnet-5/, price(2, 0.2, 10)],
  [/sonnet-4/, price(3, 0.3, 15)],
  [/haiku-4-5/, price(1, 0.1, 5)],
  [/haiku-3-5/, price(0.8, 0.08, 4)],
]

/** An unrecognised ID of a known family is priced as that family's current model. */
const BY_FAMILY: Record<Family, Price> = {
  haiku: price(1, 0.1, 5),
  sonnet: price(2, 0.2, 10),
  opus: price(4, 0.2, 20),
  fable: price(10, 0.25, 50),
}

export function priceOf(modelId: string): Price | undefined {
  const id = modelId.toLowerCase()
  for (const [pattern, p] of TABLE) if (pattern.test(id)) return p
  const family = familyOf(id)
  return family === undefined ? undefined : BY_FAMILY[family]
}

/** The token counts the API reports for a turn, summed over its requests. */
export type TurnTokens = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** A cache written with a TTL over five minutes is billed at the one-hour rate. */
export function isOneHour(ttlMs: number): boolean {
  return ttlMs > 5 * 60_000
}

/** List-price dollars for a turn's tokens on a model. */
export function turnCost(p: Price, t: TurnTokens, oneHour: boolean): number {
  const write = oneHour ? p.write1h : p.write5m
  return (t.inputTokens * p.input + t.cacheWriteTokens * write + t.cacheReadTokens * p.read + t.outputTokens * p.output) / 1e6
}

/**
 * What a switch costs: the whole context written to the new model's cache
 * (each model has its own), at that model's write price. The way back is not
 * counted: a later upgrade is a turn that needs the stronger model, and is
 * never held for price.
 */
export function switchCost(target: Price, contextTokens: number, oneHour: boolean): number {
  return (contextTokens * (oneHour ? target.write1h : target.write5m)) / 1e6
}

/**
 * What one held turn cost the person, beyond what the cheaper route would
 * have cost, in the unit their billing makes scarce:
 *
 * - `api`: dollars. The turn's tokens priced on the held model, minus the same
 *   tokens on the wanted model as if its cache were warm. On models whose
 *   cache reads cost the same (Opus 5.5 and Sonnet 5.5), only writes and
 *   output differ, so staying costs little.
 * - `subscription`: plan usage. All of the held turn counts, since it is drawn
 *   from the stronger model's allowance, which the plan meters separately and
 *   which a turn on the cheaper model would not touch.
 *
 * On `api`, keeping a higher effort on the same model (where an effort change
 * breaks the cache) costs nothing by this measure, so it stays held while the
 * cache is warm: no price list says what a lower effort saves.
 */
export function stayCost(billing: Billing, held: Price, wanted: Price, t: TurnTokens, oneHour: boolean): number {
  const onHeld = turnCost(held, t, oneHour)
  if (billing === "subscription") return onHeld
  return Math.max(0, onHeld - turnCost(wanted, t, oneHour))
}

export function dollars(n: number): string {
  if (n === 0) return "$0"
  if (n < 0.01) return "<$0.01"
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`
}
