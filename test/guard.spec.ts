import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { blockedReason, estimatedNeurons, freshGuard, normaliseGuard, PAUSES, recordFailure, recordSuccess } from "../hooks/lib/guard.ts"

const DAY1 = Date.parse("2026-10-04T10:00:00Z")
const DAY2 = Date.parse("2026-10-05T00:00:01Z")
const opts = { now: DAY1, model: "clef-flash", dailyNeuronBudget: 9000 }

describe("daily budget", () => {
  test("neurons are estimated from input tokens", () => {
    const s = { ...freshGuard(DAY1), inputTokens: 1_000_000 }
    assert.equal(Math.round(estimatedNeurons(s, "clef-flash")), 8182)
    assert.equal(Math.round(estimatedNeurons(s, "clef")), 21818)
  })

  test("the budget blocks once reached, and 0 means no limit", () => {
    const s = { ...freshGuard(DAY1), inputTokens: 1_200_000 }
    assert.equal(blockedReason(s, opts)?.kind, "budget")
    assert.equal(blockedReason(s, { ...opts, dailyNeuronBudget: 0 }), undefined)
  })

  test("counters roll over at 00:00 UTC", () => {
    const s = recordSuccess(freshGuard(DAY1), 500)
    assert.equal(normaliseGuard(s, DAY1).inputTokens, 500)
    assert.equal(normaliseGuard(s, DAY2).inputTokens, 0)
  })

  test("garbage in the store starts fresh", () => {
    assert.deepEqual(normaliseGuard("nope", DAY1), freshGuard(DAY1))
    assert.deepEqual(normaliseGuard(null, DAY1), freshGuard(DAY1))
  })
})

describe("quota and circuit breaker", () => {
  test("a quota failure blocks until the next UTC day", () => {
    const s = recordFailure(freshGuard(DAY1), { kind: "quota", message: "", latencyMs: 1 }, DAY1)
    assert.equal(blockedReason(s, opts)?.kind, "quota")
    assert.equal(blockedReason(normaliseGuard(s, DAY2), { ...opts, now: DAY2 }), undefined)
  })

  test("three failures in a row open the breaker for five minutes", () => {
    let s = freshGuard(DAY1)
    const timeout = { kind: "timeout" as const, message: "", latencyMs: 1500 }
    s = recordFailure(s, timeout, DAY1)
    s = recordFailure(s, timeout, DAY1)
    assert.equal(blockedReason(s, opts), undefined)
    s = recordFailure(s, timeout, DAY1)
    assert.equal(blockedReason(s, opts)?.kind, "circuit-open")
    assert.equal(blockedReason(s, { ...opts, now: DAY1 + PAUSES.breakerMs + 1 }), undefined)
  })

  test("a success closes the breaker", () => {
    let s = freshGuard(DAY1)
    for (let i = 0; i < 3; i++) s = recordFailure(s, { kind: "server", message: "", latencyMs: 1 }, DAY1)
    s = recordSuccess(s, 10)
    assert.equal(s.consecutiveFailures, 0)
    assert.equal(blockedReason(s, opts), undefined)
  })

  test("auth failures pause long; rate limits pause briefly", () => {
    const auth = recordFailure(freshGuard(DAY1), { kind: "auth", message: "", latencyMs: 1 }, DAY1)
    assert.equal(auth.pausedUntil, DAY1 + PAUSES.configMs)
    const rl = recordFailure(freshGuard(DAY1), { kind: "rate-limited", message: "", latencyMs: 1 }, DAY1)
    assert.equal(rl.pausedUntil, DAY1 + PAUSES.rateLimitedMs)
  })

  test("local refusals do not count as failures", () => {
    const s = freshGuard(DAY1)
    assert.equal(recordFailure(s, { kind: "not-configured", message: "", latencyMs: 0 }, DAY1), s)
    assert.equal(recordFailure(s, { kind: "budget", message: "", latencyMs: 0 }, DAY1), s)
  })
})
