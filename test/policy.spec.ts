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

describe("downgrade timing off a warm cache", () => {
  const warmOpus = { model: "claude-opus-5-5", effort: "high" as const, at: 1_000_000 - 30_000, promptTokens: 120_000 }
  // 120k written to Sonnet 5.5's cache at the 5-minute rate ($2.50/MTok): $0.30.
  const toSonnet = 0.3

  test("the first downgrade off a warm cache is held: staying has cost nothing yet", () => {
    const d = decide(input({ result: ok(rec("simple")), session: session({ cache: warmOpus }) }))
    assert.equal(d.recommendation?.level, "simple")
    assert.equal(d.final?.model, "claude-opus-5-5")
    assert.equal(d.adjustments[0]?.rule, "cache-hold")
    assert.equal(d.deferral?.held, true)
    assert.equal(d.deferral?.turns, 1)
    assert.equal(d.deferral?.wanted.model, "claude-sonnet-5-5")
    assert.ok(Math.abs(d.deferral!.cost - toSonnet) < 1e-9)
  })

  test("held on Opus 5.5, the recommended profile's effort applies (effort changes keep the cache)", () => {
    const d = decide(input({ result: ok(rec("simple")), session: session({ cache: warmOpus }) }))
    assert.equal(d.final?.effort, "low")
  })

  test("a level whose model takes no effort (Haiku) is held at the lowest effort, not the cached one", () => {
    const deep = { ...warmOpus, effort: "xhigh" as const }
    const d = decide(input({ result: ok(rec("trivial")), session: session({ cache: deep }) }))
    assert.equal(d.final?.model, "claude-opus-5-5")
    assert.equal(d.final?.effort, "low")
  })

  test("where effort changes break the cache, the cached effort is kept too", () => {
    const old = { ...warmOpus, model: "claude-opus-4-8" }
    const d = decide(input({ result: ok(rec("simple")), session: session({ cache: old }) }))
    assert.equal(d.final?.model, "claude-opus-4-8")
    assert.equal(d.final?.effort, "high")
  })

  test("the downgrade is taken once staying has cost what the switch costs", () => {
    const wanted = { level: "simple" as const, model: "claude-sonnet-5-5", effort: "low" as const }
    const under = decide(input({ result: ok(rec("simple")), session: session({ cache: warmOpus, hold: { model: "claude-opus-5-5", wanted, spent: 0.29, turns: 2 } }) }))
    assert.equal(under.final?.model, "claude-opus-5-5")
    assert.equal(under.deferral?.turns, 3)
    assert.equal(under.deferral?.spent, 0.29)
    const over = decide(input({ result: ok(rec("simple")), session: session({ cache: warmOpus, hold: { model: "claude-opus-5-5", wanted, spent: 0.31, turns: 3 } }) }))
    assert.equal(over.final?.model, "claude-sonnet-5-5")
    assert.equal(over.final?.effort, "low")
    assert.deepEqual(over.adjustments, [])
    assert.equal(over.deferral?.held, false)
    assert.equal(over.deferral?.turns, 3)
  })

  test("downgrade_patience scales what staying must cost first", () => {
    const wanted = { level: "simple" as const, model: "claude-sonnet-5-5", effort: "low" as const }
    const hold = { model: "claude-opus-5-5", wanted, spent: 0.31, turns: 3 }
    const d = decide(input({ config: config({ downgrade_patience: 2 }), result: ok(rec("simple")), session: session({ cache: warmOpus, hold }) }))
    assert.equal(d.final?.model, "claude-opus-5-5")
  })

  test("downgrade_patience = 0 takes every downgrade at once", () => {
    const d = decide(input({ config: config({ downgrade_patience: 0 }), result: ok(rec("trivial")), session: session({ cache: warmOpus }) }))
    assert.equal(d.final?.model, "claude-haiku-4-5")
    assert.equal(d.deferral, undefined)
  })

  test("what a switch costs follows the context now, and the cache TTL's write price", () => {
    const d = decide(input({ result: ok(rec("simple")), session: session({ cache: warmOpus }), contextTokens: 200_000, cacheTtlMs: 60 * 60_000 }))
    // 200k at Sonnet 5.5's one-hour write price ($4/MTok).
    assert.ok(Math.abs(d.deferral!.cost - 0.8) < 1e-9)
  })

  test("what was spent holding another model does not carry over", () => {
    const wanted = { model: "claude-haiku-4-5" }
    const d = decide(input({ result: ok(rec("trivial")), session: session({ cache: warmOpus, hold: { model: "claude-sonnet-5-5", wanted, spent: 5, turns: 4 } }) }))
    assert.equal(d.final?.model, "claude-opus-5-5")
    assert.equal(d.deferral?.turns, 1)
  })

  test("a continuation of a held turn weighs the deferred downgrade again", () => {
    const wanted = { level: "simple" as const, model: "claude-sonnet-5-5", effort: "low" as const }
    const last = { level: "simple" as const, model: "claude-opus-5-5", effort: "low" as const }
    const stay = decide(input({ kind: "go-ahead", session: session({ cache: warmOpus, last, hold: { model: "claude-opus-5-5", wanted, spent: 0.1, turns: 1 } }) }))
    assert.equal(stay.source, "continuation")
    assert.equal(stay.final?.model, "claude-opus-5-5")
    assert.equal(stay.deferral?.turns, 2)
    const go = decide(input({ kind: "go-ahead", session: session({ cache: warmOpus, last, hold: { model: "claude-opus-5-5", wanted, spent: 0.5, turns: 2 } }) }))
    assert.equal(go.final?.model, "claude-sonnet-5-5")
  })

  test("a lower effort that would break the cache is weighed the same way", () => {
    const old = { ...warmOpus, model: "claude-opus-4-8" }
    const wanted = { level: "hard" as const, model: "claude-opus-4-8", effort: "medium" as const }
    const profiles = { profile_hard: "claude-opus-4-8:medium" }
    const held = decide(input({ config: config(profiles), result: ok(rec("hard")), session: session({ cache: old }) }))
    assert.equal(held.final?.effort, "high")
    assert.equal(held.deferral?.wanted.effort, "medium")
    // 120k rewritten on Opus 4.8 at $6.25/MTok: $0.75.
    const taken = decide(input({ config: config(profiles), result: ok(rec("hard")), session: session({ cache: old, hold: { model: "claude-opus-4-8", wanted, spent: 0.8, turns: 2 } }) }))
    assert.equal(taken.final?.effort, "medium")
  })

  test("a cold cache does not hold", () => {
    const cold = { ...warmOpus, at: 1_000_000 - 10 * 60_000 }
    const d = decide(input({ result: ok(rec("trivial")), session: session({ cache: cold }) }))
    assert.equal(d.final?.model, "claude-haiku-4-5")
  })

  test("nothing is held where nothing is cached (a gateway that strips cache markers)", () => {
    const d = decide(input({ result: ok(rec("trivial")), session: session({ cache: { ...warmOpus, caching: false } }) }))
    assert.equal(d.final?.model, "claude-haiku-4-5")
  })

  test("an upgrade is never held", () => {
    const warmSonnet = { ...warmOpus, model: "claude-sonnet-5-5", effort: "medium" as const }
    const d = decide(input({ result: ok(rec("deep")), session: session({ cache: warmSonnet }) }))
    assert.equal(d.final?.model, "claude-opus-5-5")
    assert.equal(d.final?.effort, "xhigh")
  })

  test("explicit choices are never held", () => {
    const d = decide(input({ override: { level: "trivial" }, session: session({ cache: warmOpus }) }))
    assert.equal(d.final?.model, "claude-haiku-4-5")
  })

  test("the decision records the billing it was made for", () => {
    const d = decide(input({ billing: "api", result: ok(rec("hard")) }))
    assert.equal(d.billing, "api")
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
