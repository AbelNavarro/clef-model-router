import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { profilesReport, statusLine, statusReport, historyReport, explain } from "../hooks/lib/format.ts"
import { aggregate, logFileName, parseLines, promptHash, turnRecord } from "../hooks/lib/log.ts"
import { detectBilling } from "../hooks/lib/env.ts"
import { FIRST_PARTY_ENV } from "../hooks/lib/models.ts"
import { decide } from "../hooks/lib/policy.ts"
import { presence, redact } from "../hooks/lib/redact.ts"
import { config, input, ok, rec, session } from "./helpers.ts"

describe("redaction", () => {
  test("bearer tokens, key=value secrets, long opaque strings and named secrets", () => {
    const token = "cfut_" + "x".repeat(40)
    const out = redact(`Authorization: Bearer ${token} api_token=abc123 id 0123456789abcdef0123456789abcdef`, [token])
    assert.ok(!out.includes(token))
    assert.ok(!out.includes("abc123"))
    assert.ok(!out.includes("0123456789abcdef0123456789abcdef"))
    assert.equal(redact("plain message"), "plain message")
  })

  test("status shows presence, never the value", () => {
    assert.equal(presence("secret"), "set")
    assert.equal(presence(undefined), "not set")
    const text = statusReport({
      config: config({ cloudflare_api_token: "SUPERSECRET_TOKEN_VALUE" }),
      configProblems: [],
      modelEnv: FIRST_PARTY_ENV,
      mode: "auto",
      guard: { calls: 0, inputTokens: 0, neurons: 0 },
      billing: { billing: "subscription", detected: detectBilling({}), configured: "auto", patience: 1 },
      unavailable: [],
      logDir: "/tmp/x",
    })
    assert.ok(!text.includes("SUPERSECRET"))
    assert.match(text, /token set/)
  })
})

describe("log records", () => {
  test("prompt text is left out by default; hash and length kept", async () => {
    const d = decide(input({ result: ok(rec("hard", 0.8)) }))
    const hash = await promptHash("Debug the deadlock")
    assert.equal(hash.length, 16)
    const r = turnRecord({ decision: d, session: "s1", ts: "2026-10-04T10:00:00.000Z", promptText: "Debug the deadlock", hash, logPrompts: false })
    assert.equal(r.prompt, undefined)
    assert.equal(r.promptHash, hash)
    assert.equal(r.promptChars, 18)
    assert.equal(r.recommendation?.level, "hard")
    assert.equal(r.recommendation?.confidence, 0.8)
    assert.equal(r.final?.model, "claude-opus-5-5")
    assert.equal(r.latencyMs, 42)
    const withText = turnRecord({ decision: d, session: "s1", ts: "x", promptText: "Debug", logPrompts: true })
    assert.equal(withText.prompt, "Debug")
  })

  test("file names are per day and session, and safe", () => {
    assert.equal(logFileName("2026-10-04T10:00:00Z", "abc/../def-123456789012345"), "routing-2026-10-04-abcdef-12345.jsonl")
  })

  test("torn lines are skipped", () => {
    const lines = ['{"v":1,"type":"turn"', '{"v":1,"type":"feedback","verdict":"ok","ts":"x","session":"s"}', "", "garbage"].join("\n")
    assert.equal(parseLines(lines).length, 1)
  })

  test("aggregate answers: by model, by effort, latency, confidence, fallbacks, overrides, holds", () => {
    const warm = { model: "claude-opus-5-5", effort: "high" as const, at: 1_000_000 - 1000, promptTokens: 100_000 }
    const decisions = [
      decide(input({ result: ok(rec("hard", 0.8, { latencyMs: 40 })) })),
      decide(input({ result: ok(rec("trivial", 0.9, { latencyMs: 60 })), session: session({ cache: warm }) })),
      decide(input({ result: { ok: false, failure: { kind: "timeout", message: "t", latencyMs: 1500 } } })),
      decide(input({ override: { level: "deep" } })),
    ]
    const records = decisions.map((d, i) => turnRecord({ decision: d, session: "s", ts: `2026-10-04T10:00:0${i}Z`, promptText: "p", logPrompts: false }))
    const s = aggregate([...records, { v: 1, type: "feedback", ts: "x", session: "s", verdict: "under" }])
    assert.equal(s.turns, 4)
    assert.equal(s.byModel["claude-opus-5-5"], 3)
    assert.equal(s.byModel["claude-sonnet-5-5"], 1)
    assert.equal(s.clefCalls, 3)
    assert.deepEqual(s.latency, { mean: 50, p50: 40, p95: 60 })
    assert.equal(Math.round((s.meanConfidence ?? 0) * 100), 85)
    assert.equal(s.failures.timeout, 1)
    assert.equal(s.overrides, 1)
    assert.equal(s.cacheHolds, 1)
    assert.equal(s.recommendationChanged, 1)
    assert.equal(s.feedback.under, 1)
  })
})

describe("display", () => {
  test("status line forms", () => {
    assert.equal(statusLine(decide(input({ result: ok(rec("standard", 0.87)) }))), "Clef → Sonnet · medium · 87%")
    assert.equal(statusLine(decide(input({ result: ok(rec("hard", 0.71)) }))), "Clef → Opus · high · 71%")
    assert.equal(
      statusLine(decide(input({ result: { ok: false, failure: { kind: "timeout", message: "", latencyMs: 1500 } } }))),
      "Clef ✕ timeout → Sonnet · medium",
    )
    const warm = { model: "claude-opus-5-5", effort: "high" as const, at: 1_000_000 - 1000, promptTokens: 100_000 }
    // A held downgrade names what it held back, and the effort still comes down.
    assert.equal(statusLine(decide(input({ result: ok(rec("trivial", 0.9)), session: session({ cache: warm }) }))), "Clef → Opus · low · 90% (Haiku deferred)")
    assert.equal(statusLine(decide(input({ override: { model: "opus", effort: "max" } }))), "+ Opus · max")
    assert.equal(statusLine(decide(input({ session: session({ mode: "off" }) }))), "Clef off")
  })

  test("explain shows the distribution and every policy change", () => {
    const warm = { model: "claude-opus-5-5", effort: "high" as const, at: 1_000_000 - 1000, promptTokens: 100_000 }
    const lines = explain(decide(input({ result: ok(rec("trivial", 0.9)), session: session({ cache: warm }) }))).join("\n")
    assert.match(lines, /trivial .*90%.*← Clef/)
    assert.match(lines, /cache-hold: Haiku → Opus · low/)
    assert.match(lines, /downgrade Haiku deferred \(held turn 1\): staying has cost \$0 so far, a switch costs \$0\.13 now \(subscription, list prices\)/)
  })

  test("history and profiles render", () => {
    const d = decide(input({ result: ok(rec("hard", 0.8)) }))
    assert.match(historyReport([{ decision: d, prompt: "Debug the deadlock" }]), /Opus · high .* 80% .*clef .*Debug the deadlock/)
    assert.match(profilesReport(config(), FIRST_PARTY_ENV, []), /trivial\s+haiku\s+→ claude-haiku-4-5/)
  })
})
