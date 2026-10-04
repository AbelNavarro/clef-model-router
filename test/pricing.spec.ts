import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { dollars, isOneHour, priceOf, stayCost, switchCost, turnCost } from "../hooks/lib/pricing.ts"

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`)

describe("prices", () => {
  test("list prices by model, most specific first", () => {
    assert.deepEqual(priceOf("claude-opus-5-5"), { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 })
    assert.equal(priceOf("claude-opus-5")?.read, 0.5)
    assert.equal(priceOf("claude-opus-4-8")?.input, 5)
    assert.equal(priceOf("claude-opus-4-1")?.input, 15)
    assert.equal(priceOf("claude-sonnet-5-5")?.read, 0.2)
    assert.equal(priceOf("claude-sonnet-4-6")?.input, 3)
    assert.equal(priceOf("claude-haiku-4-5")?.write5m, 1.25)
    assert.equal(priceOf("claude-fable-5-1")?.read, 0.25)
    assert.equal(priceOf("claude-fable-5")?.read, 1)
  })

  test("provider IDs match, unknown IDs of a known family get its current price, others none", () => {
    assert.equal(priceOf("us.anthropic.claude-sonnet-4-5-20250929-v1:0")?.input, 3)
    assert.equal(priceOf("claude-opus-9-preview")?.input, 4)
    assert.equal(priceOf("gpt-x"), undefined)
  })
})

describe("costs", () => {
  const turn = { inputTokens: 0, outputTokens: 1_500, cacheReadTokens: 240_000, cacheWriteTokens: 5_000 }
  const opus = priceOf("claude-opus-5-5")!
  const sonnet = priceOf("claude-sonnet-5-5")!

  test("a turn: reads, writes at the TTL's rate, output", () => {
    // 240k × $0.20 + 5k × $5 + 1.5k × $20
    close(turnCost(opus, turn, false), 0.048 + 0.025 + 0.03)
    close(turnCost(opus, turn, true), 0.048 + 0.04 + 0.03)
  })

  test("a switch writes the whole context to the new model's cache", () => {
    close(switchCost(sonnet, 60_000, false), 0.15)
    close(switchCost(sonnet, 60_000, true), 0.24)
  })

  test("on the API, staying on Opus 5.5 costs only the difference from Sonnet 5.5: their cache reads cost the same", () => {
    // writes 5k × ($5 − $2.50) + output 1.5k × ($20 − $10)
    close(stayCost("api", opus, sonnet, turn, false), 0.0125 + 0.015)
  })

  test("on a subscription, the whole held turn counts: it comes out of the stronger model's allowance", () => {
    close(stayCost("subscription", opus, sonnet, turn, true), turnCost(opus, turn, true))
  })

  test("staying never counts negative", () => {
    assert.equal(stayCost("api", sonnet, opus, turn, false), 0)
  })

  test("TTL and money formatting", () => {
    assert.equal(isOneHour(60 * 60_000), true)
    assert.equal(isOneHour(5 * 60_000), false)
    assert.equal(dollars(0), "$0")
    assert.equal(dollars(0.004), "<$0.01")
    assert.equal(dollars(0.237), "$0.24")
    assert.equal(dollars(12.4), "$12")
  })
})
