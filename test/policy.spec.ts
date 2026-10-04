import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { decide, needsClef } from "../hooks/lib/policy.ts"
import { config, input, ok, rec, session } from "./helpers.ts"

describe("Clef recommendation → route", () => {
  test("a confident recommendation is followed, profile → model + effort", () => {
    const d = decide(input({ result: ok(rec("hard", 0.85)) }))
    assert.equal(d.source, "clef")
    assert.equal(d.final?.level, "hard")
    assert.equal(d.final?.model, "claude-opus-5-5")
    assert.equal(d.final?.effort, "high")
    assert.deepEqual(d.adjustments, [])
    assert.equal(d.recommendation?.level, "hard")
  })

  test("the trivial profile sends no effort (Haiku takes none)", () => {
    const d = decide(input({ result: ok(rec("trivial", 0.95)) }))
    assert.equal(d.final?.model, "claude-haiku-4-5")
    assert.equal(d.final?.effort, undefined)
  })

  test("recommendation and final route stay distinguishable after policy", () => {
    const d = decide(input({ result: ok(rec("simple", 0.4)) }))
    assert.equal(d.recommendation?.level, "simple")
    assert.equal(d.proposed?.level, "simple")
    assert.equal(d.final?.level, "standard")
    assert.equal(d.adjustments[0]?.rule, "low-confidence")
  })
})

describe("low-confidence policy", () => {
  const unsure = () => {
    const r = rec("simple", 0.4)
    r.probabilities = { trivial: 0.35, simple: 0.4, standard: 0.2, hard: 0.05, deep: 0 }
    return ok(r)
  }

  test("upper-of-top-two picks the more capable of the two likeliest levels", () => {
    const d = decide(input({ result: unsure() }))
    // top two are simple (0.40) and trivial (0.35): the upper is simple.
    assert.equal(d.final?.level, "simple")
    assert.deepEqual(d.adjustments, [])
  })

  test("upper-of-top-two moves up when the runner-up is above", () => {
    const r = rec("simple", 0.45)
    r.probabilities = { trivial: 0.05, simple: 0.45, standard: 0.4, hard: 0.1, deep: 0 }
    const d = decide(input({ result: ok(r) }))
    assert.equal(d.final?.level, "standard")
  })

  test("bump goes one level up", () => {
    const d = decide(input({ config: config({ low_confidence_policy: "bump" }), result: unsure() }))
    assert.equal(d.final?.level, "standard")
  })

  test("hold keeps the last route's level, or the fallback", () => {
    const cfg = config({ low_confidence_policy: "hold" })
    const held = decide(input({ config: cfg, result: unsure(), session: session({ last: { level: "hard", model: "claude-opus-5-5", effort: "high" } }) }))
    assert.equal(held.final?.level, "hard")
    const none = decide(input({ config: cfg, result: unsure() }))
    assert.equal(none.final?.level, "standard")
  })

  test("fallback uses the fallback profile", () => {
    const d = decide(input({ config: config({ low_confidence_policy: "fallback", fallback_profile: "hard" }), result: unsure() }))
    assert.equal(d.final?.level, "hard")
  })

  test("obey follows Clef regardless", () => {
    const d = decide(input({ config: config({ low_confidence_policy: "obey" }), result: unsure() }))
    assert.equal(d.final?.level, "simple")
  })

  test("at or above the threshold nothing changes", () => {
    const d = decide(input({ config: config({ confidence_threshold: 0.4, low_confidence_policy: "bump" }), result: unsure() }))
    assert.equal(d.final?.level, "simple")
  })
})

describe("fallback", () => {
  test("a Clef failure uses the fallback profile and says why", () => {
    const d = decide(input({ result: { ok: false, failure: { kind: "timeout", message: "no answer within 1500 ms", latencyMs: 1500 } } }))
    assert.equal(d.source, "fallback")
    assert.equal(d.final?.level, "standard")
    assert.equal(d.failure?.kind, "timeout")
    assert.match(d.note ?? "", /timeout/)
  })

  test("a fallback never routes below the last route", () => {
    const d = decide(
      input({
        result: { ok: false, failure: { kind: "server", message: "8000", latencyMs: 90 } },
        session: session({ last: { level: "deep", model: "claude-opus-5-5", effort: "xhigh" } }),
      }),
    )
    assert.equal(d.final?.level, "deep")
  })

  test("not configured still routes, on the fallback profile", () => {
    const d = decide(input({ result: { ok: false, failure: { kind: "not-configured", message: "x", latencyMs: 0 } } }))
    assert.equal(d.final?.model, "claude-sonnet-5-5")
    assert.equal(d.final?.effort, "medium")
  })
})

describe("precedence", () => {
  test("disabled in config leaves the request alone, even with a pin", () => {
    const d = decide(input({ config: config({ enabled: false }), session: session({ pin: { level: "deep" } }) }))
    assert.equal(d.final, undefined)
    assert.equal(d.source, "disabled")
  })

  test("/clef off leaves the request alone", () => {
    const d = decide(input({ session: session({ mode: "off" }), result: ok(rec("hard")) }))
    assert.equal(d.final, undefined)
  })

  test("a native /model change pauses routing", () => {
    const d = decide(input({ session: session({ mode: "paused-native" }), result: ok(rec("hard")) }))
    assert.equal(d.final, undefined)
    assert.equal(d.source, "native")
  })

  test("a one-turn +model applies even while routing is off or paused, without a Clef call", () => {
    for (const mode of ["off", "paused-native"] as const) {
      const d = decide(input({ session: session({ mode }), override: { model: "opus", effort: "max" } }))
      assert.equal(d.final?.model, "claude-opus-5-5", mode)
      assert.equal(needsClef({ turnId: "t", kind: "prompt", config: config(), modelEnv: input().modelEnv, session: session({ mode }), override: { model: "opus" } }), false)
    }
    // An effort-only +:high has no model to apply it to while off.
    assert.equal(decide(input({ session: session({ mode: "off" }), override: { effort: "high" } })).final, undefined)
  })

  test("but enabled = false is fully inert", () => {
    assert.equal(decide(input({ config: config({ enabled: false }), override: { model: "opus" } })).final, undefined)
  })

  test("+off leaves one turn alone", () => {
    const d = decide(input({ override: "off", result: ok(rec("hard")) }))
    assert.equal(d.final, undefined)
  })

  test("a one-turn override beats a session pin", () => {
    const d = decide(input({ override: { model: "opus", effort: "max" }, session: session({ pin: { level: "trivial" } }) }))
    assert.equal(d.source, "override")
    assert.equal(d.final?.model, "claude-opus-5-5")
    assert.equal(d.final?.effort, "max")
  })

  test("a pin beats Clef", () => {
    const d = decide(input({ session: session({ pin: { level: "simple" } }), result: ok(rec("deep")) }))
    assert.equal(d.source, "pin")
    assert.equal(d.final?.level, "simple")
  })

  test("an effort-only pin keeps Clef's model choice", () => {
    const d = decide(input({ session: session({ pin: { effort: "low" } }), result: ok(rec("hard")) }))
    assert.equal(d.source, "clef")
    assert.equal(d.final?.model, "claude-opus-5-5")
    assert.equal(d.final?.effort, "low")
    assert.equal(d.adjustments.at(-1)?.rule, "pinned-effort")
  })

  test("an override of a model without effort keeps Claude Code's effort", () => {
    const d = decide(input({ override: { model: "sonnet" } }))
    assert.equal(d.final?.model, "claude-sonnet-5-5")
    assert.equal(d.final?.effort, undefined)
  })

  test("explicit choices and continuations make no Clef call", () => {
    const base = { turnId: "t", config: config(), modelEnv: input().modelEnv }
    assert.equal(needsClef({ ...base, kind: "prompt", session: session() }), true)
    assert.equal(needsClef({ ...base, kind: "prompt", session: session(), override: { level: "hard" } }), false)
    assert.equal(needsClef({ ...base, kind: "prompt", session: session({ pin: { model: "opus" } }) }), false)
    assert.equal(needsClef({ ...base, kind: "prompt", session: session({ pin: { effort: "low" } }) }), true)
    const last = { level: "hard" as const, model: "claude-opus-5-5" }
    assert.equal(needsClef({ ...base, kind: "go-ahead", session: session({ last }) }), false)
    assert.equal(needsClef({ ...base, kind: "go-ahead", session: session() }), true)
    assert.equal(needsClef({ ...base, kind: "notification", session: session() }), false)
    assert.equal(needsClef({ ...base, kind: "prompt", session: session({ mode: "off" }) }), false)
  })
})

describe("continuations", () => {
  const last = { level: "hard" as const, model: "claude-opus-5-5", effort: "high" as const }

  test("a go-ahead reuses the last route", () => {
    const d = decide(input({ kind: "go-ahead", session: session({ last }) }))
    assert.equal(d.source, "continuation")
    assert.deepEqual(d.final, last)
  })

  test("a task notification with nothing to continue is left alone", () => {
    const d = decide(input({ kind: "notification" }))
    assert.equal(d.final, undefined)
  })

  test("a follow-up never routes below the turn it follows", () => {
    const d = decide(input({ result: ok(rec("trivial", 0.9, { contextDependent: 0.8 })), session: session({ last }) }))
    assert.equal(d.final?.level, "hard")
    assert.equal(d.adjustments[0]?.rule, "context-dependent")
  })

  test("a self-contained easy prompt after a hard one can go down", () => {
    const d = decide(input({ result: ok(rec("trivial", 0.9, { contextDependent: 0.1 })), session: session({ last }) }))
    assert.equal(d.final?.level, "trivial")
  })
})

describe("availability and context window", () => {
  test("an unavailable model moves to the nearest profile, upward first", () => {
    const d = decide(input({ result: ok(rec("trivial")), session: session({ unavailable: ["claude-haiku-4-5"] }) }))
    assert.equal(d.final?.level, "simple")
    assert.equal(d.adjustments[0]?.rule, "unavailable")
  })

  test("aliases do not resolve on a third-party provider without a pinned ID", () => {
    const d = decide(input({ result: ok(rec("hard")), modelEnv: { defaults: { sonnet: "us.anthropic.claude-sonnet-x-v1:0" }, thirdParty: true, betasDisabled: false } }))
    // opus cannot resolve: nearest is upward (deep, also opus), then downward to standard (sonnet).
    assert.equal(d.final?.model, "us.anthropic.claude-sonnet-x-v1:0")
  })

  test("nothing resolvable leaves the request alone", () => {
    const d = decide(input({ result: ok(rec("hard")), modelEnv: { defaults: {}, thirdParty: true, betasDisabled: false } }))
    assert.equal(d.final, undefined)
  })

  test("a context too big for Haiku moves up to a profile that fits", () => {
    const d = decide(input({ result: ok(rec("trivial")), contextTokens: 250_000 }))
    assert.equal(d.final?.model, "claude-sonnet-5-5")
    assert.ok(d.adjustments.some((a) => a.rule === "context-window"))
  })
})

describe("cache-aware hold", () => {
  const warmOpus = { model: "claude-opus-5-5", effort: "high" as const, at: 1_000_000 - 30_000, promptTokens: 120_000 }

  test("a downgrade with a large warm cache keeps the model, applying the new effort when that is free", () => {
    const d = decide(input({ result: ok(rec("trivial")), session: session({ cache: warmOpus }) }))
    assert.equal(d.recommendation?.level, "trivial")
    assert.equal(d.final?.model, "claude-opus-5-5")
    // Haiku had no effort, so the cached effort stays.
    assert.equal(d.final?.effort, "high")
    assert.equal(d.adjustments[0]?.rule, "cache-hold")
  })

  test("held on Opus 5.5, the recommended profile's effort applies (effort changes keep the cache)", () => {
    const d = decide(input({ result: ok(rec("simple")), session: session({ cache: warmOpus }) }))
    assert.equal(d.final?.model, "claude-opus-5-5")
    assert.equal(d.final?.effort, "low")
  })

  test("where effort changes break the cache, the cached effort is kept too", () => {
    const old = { ...warmOpus, model: "claude-opus-4-8" }
    const d = decide(input({ result: ok(rec("simple")), session: session({ cache: old }) }))
    assert.equal(d.final?.model, "claude-opus-4-8")
    assert.equal(d.final?.effort, "high")
  })

  test("a cold cache does not hold", () => {
    const cold = { ...warmOpus, at: 1_000_000 - 10 * 60_000 }
    const d = decide(input({ result: ok(rec("trivial")), session: session({ cache: cold }) }))
    assert.equal(d.final?.model, "claude-haiku-4-5")
  })

  test("a small context does not hold", () => {
    const small = { ...warmOpus, promptTokens: 20_000 }
    const d = decide(input({ result: ok(rec("trivial")), session: session({ cache: small }) }))
    assert.equal(d.final?.model, "claude-haiku-4-5")
  })

  test("an upgrade is never held", () => {
    const warmSonnet = { ...warmOpus, model: "claude-sonnet-5-5", effort: "medium" as const }
    const d = decide(input({ result: ok(rec("deep")), session: session({ cache: warmSonnet }) }))
    assert.equal(d.final?.model, "claude-opus-5-5")
    assert.equal(d.final?.effort, "xhigh")
  })

  test("cache_hold_min_tokens = 0 disables holding", () => {
    const d = decide(input({ config: config({ cache_hold_min_tokens: 0 }), result: ok(rec("trivial")), session: session({ cache: warmOpus }) }))
    assert.equal(d.final?.model, "claude-haiku-4-5")
  })

  test("explicit choices are never held", () => {
    const d = decide(input({ override: { level: "trivial" }, session: session({ cache: warmOpus }) }))
    assert.equal(d.final?.model, "claude-haiku-4-5")
  })
})

describe("effort cap and clamp", () => {
  test("max_effort caps the route", () => {
    const d = decide(input({ config: config({ max_effort: "high" }), result: ok(rec("deep")) }))
    assert.equal(d.final?.effort, "high")
    assert.equal(d.adjustments[0]?.rule, "effort-cap")
  })

  test("an effort the model lacks is clamped down", () => {
    const d = decide(input({ override: { model: "claude-opus-4-6", effort: "xhigh" } }))
    assert.equal(d.final?.effort, "high")
    assert.equal(d.adjustments[0]?.rule, "effort-clamp")
  })

  test("an effort override on Haiku is dropped", () => {
    const d = decide(input({ override: { model: "haiku", effort: "max" } }))
    assert.equal(d.final?.effort, undefined)
  })
})

describe("confidence semantics (real clef-flash answers)", () => {
  test("a clear 60% pick stays put even though Clef's own confidence reads 31%", () => {
    const r = rec("trivial", 0.6, { providerConfidence: 0.31 })
    r.probabilities = { trivial: 0.6, simple: 0.28, standard: 0.08, hard: 0.02, deep: 0.02 }
    const d = decide(input({ result: ok(r) }))
    assert.equal(d.final?.level, "trivial")
    assert.deepEqual(d.adjustments, [])
  })

  test("a split 47/35 pick still moves to the more capable of the two", () => {
    const r = rec("trivial", 0.47, { providerConfidence: 0.2 })
    r.probabilities = { trivial: 0.47, simple: 0.35, standard: 0.1, hard: 0.05, deep: 0.03 }
    const d = decide(input({ result: ok(r) }))
    assert.equal(d.final?.level, "simple")
    assert.equal(d.adjustments[0]?.rule, "low-confidence")
  })
})
