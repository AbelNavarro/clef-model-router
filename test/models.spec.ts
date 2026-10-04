import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  clampEffort,
  displayName,
  effortChangeKeepsCache,
  effortsFor,
  FIRST_PARTY_ENV,
  rankOf,
  resolveModel,
  sameModel,
  windowOf,
} from "../hooks/lib/models.ts"

describe("model resolution", () => {
  test("aliases resolve to full IDs (turn.step does not resolve aliases itself)", () => {
    assert.equal(resolveModel("haiku", FIRST_PARTY_ENV), "claude-haiku-4-5")
    assert.equal(resolveModel("sonnet", FIRST_PARTY_ENV), "claude-sonnet-5-5")
    assert.equal(resolveModel("opus", FIRST_PARTY_ENV), "claude-opus-5-5")
    assert.equal(resolveModel("fable", FIRST_PARTY_ENV), "claude-fable-5-1")
    assert.equal(resolveModel("claude-opus-4-8", FIRST_PARTY_ENV), "claude-opus-4-8")
  })

  test("ANTHROPIC_DEFAULT_*_MODEL pins win", () => {
    assert.equal(resolveModel("opus", { ...FIRST_PARTY_ENV, defaults: { opus: "claude-opus-5" } }), "claude-opus-5")
  })

  test("an unpinned alias on a third-party provider does not resolve", () => {
    assert.equal(resolveModel("opus", { defaults: {}, thirdParty: true, betasDisabled: false }), undefined)
  })

  test("ranks and names", () => {
    assert.ok(rankOf("claude-haiku-4-5")! < rankOf("claude-sonnet-5-5")!)
    assert.ok(rankOf("claude-sonnet-5-5")! < rankOf("claude-opus-5-5")!)
    assert.ok(rankOf("claude-opus-5-5")! < rankOf("claude-fable-5-1")!)
    assert.equal(rankOf("mystery-model"), undefined)
    assert.equal(displayName("claude-sonnet-5-5"), "Sonnet")
    assert.equal(displayName("mystery-model"), "mystery-model")
  })

  test("dated IDs and [1m] compare equal", () => {
    assert.ok(sameModel("claude-haiku-4-5", "claude-haiku-4-5-20251001"))
    assert.ok(sameModel("claude-opus-5-5[1m]", "claude-opus-5-5"))
    assert.ok(!sameModel("claude-opus-5-5", "claude-opus-5"))
  })
})

describe("effort compatibility", () => {
  test("Haiku 4.5 takes no effort", () => {
    assert.equal(effortsFor("claude-haiku-4-5"), null)
    assert.equal(clampEffort("claude-haiku-4-5", "high"), undefined)
  })

  test("5.x models take all five levels", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5", "claude-opus-4-8"]) {
      assert.equal(clampEffort(id, "xhigh"), "xhigh", id)
      assert.equal(clampEffort(id, "max"), "max", id)
    }
  })

  test("4.6 models clamp xhigh to high", () => {
    assert.equal(clampEffort("claude-opus-4-6", "xhigh"), "high")
    assert.equal(clampEffort("claude-sonnet-4-6", "max"), "max")
  })

  test("unknown models pass effort through", () => {
    assert.equal(clampEffort("some-gateway-model", "xhigh"), "xhigh")
  })

  test("effort changes keep the cache only on 5.5 / Fable 5.1, first party", () => {
    assert.equal(effortChangeKeepsCache("claude-opus-5-5", FIRST_PARTY_ENV), true)
    assert.equal(effortChangeKeepsCache("claude-sonnet-5-5", FIRST_PARTY_ENV), true)
    assert.equal(effortChangeKeepsCache("claude-fable-5-1", FIRST_PARTY_ENV), true)
    assert.equal(effortChangeKeepsCache("claude-opus-5", FIRST_PARTY_ENV), false)
    assert.equal(effortChangeKeepsCache("claude-opus-5-5", { defaults: {}, thirdParty: true, betasDisabled: false }), false)
    assert.equal(effortChangeKeepsCache("claude-opus-5-5", { defaults: {}, thirdParty: false, betasDisabled: true }), false)
  })

  test("windows: only Haiku's smaller window is guarded", () => {
    assert.equal(windowOf("claude-haiku-4-5"), 200_000)
    assert.equal(windowOf("claude-opus-5-5"), undefined)
  })
})
