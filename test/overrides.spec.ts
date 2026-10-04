import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { parseCommand, parsePrefix, parseTarget, trackNativeEffort, turnKind } from "../hooks/lib/overrides.ts"

describe("targets", () => {
  test("profiles, aliases, IDs, efforts", () => {
    assert.deepEqual(parseTarget("hard"), { level: "hard" })
    assert.deepEqual(parseTarget("opus:max"), { model: "opus", effort: "max" })
    assert.deepEqual(parseTarget("Opus"), { model: "opus" })
    assert.deepEqual(parseTarget("claude-sonnet-5-5:low"), { model: "claude-sonnet-5-5", effort: "low" })
    assert.deepEqual(parseTarget(":high"), { effort: "high" })
    assert.deepEqual(parseTarget("deep:medium"), { level: "deep", effort: "medium" })
  })

  test("anything else is not a target", () => {
    for (const t of ["", "1", "gpt-5", ":ultra", "opus:loud", "fix"]) assert.equal(parseTarget(t), undefined, t)
  })
})

describe("+prefix", () => {
  test("a valid prefix is removed and becomes a one-turn override", () => {
    assert.deepEqual(parsePrefix("+opus:max why does this deadlock?"), { text: "why does this deadlock?", override: { model: "opus", effort: "max" } })
    assert.deepEqual(parsePrefix("+trivial rename foo"), { text: "rename foo", override: { level: "trivial" } })
    assert.deepEqual(parsePrefix("+off just answer"), { text: "just answer", override: "off" })
  })

  test("anything else is left untouched", () => {
    for (const text of ["+1", "+1 agreed", "+ opus do it", "use +opus here", "+gpt do it", "Fix the typo"]) {
      assert.deepEqual(parsePrefix(text), { text }, text)
    }
  })
})

describe("turn kinds", () => {
  test("go-aheads", () => {
    for (const t of ["yes", "Yes!", "ok", "go ahead", "do it.", "continue", "LGTM", "sounds good", "yes, do it", "ok, go ahead", "Yes please!", "lgtm, ship it"])
      assert.equal(turnKind(t), "go-ahead", t)
  })

  test("prompts that merely start like a go-ahead", () => {
    for (const t of ["yes but first check the tests", "ok now refactor the parser", "continue the migration but skip users table", "no", "good", "it", "do not do it"]) {
      assert.equal(turnKind(t), "prompt", t)
    }
  })

  test("notifications and empty turns", () => {
    assert.equal(turnKind("<task-notification><task-id>x</task-id></task-notification>"), "notification")
    assert.equal(turnKind("   "), "empty")
  })
})

describe("/clef commands", () => {
  test("subcommands", () => {
    assert.deepEqual(parseCommand(""), { kind: "status" })
    assert.deepEqual(parseCommand("history"), { kind: "history" })
    assert.deepEqual(parseCommand("stats"), { kind: "stats", days: 7 })
    assert.deepEqual(parseCommand("stats 30"), { kind: "stats", days: 30 })
    assert.equal(parseCommand("stats -1").kind, "error")
    assert.deepEqual(parseCommand("test fix the typo"), { kind: "test", prompt: "fix the typo" })
    assert.deepEqual(parseCommand("pin opus:high"), { kind: "pin", target: { model: "opus", effort: "high" } })
    assert.deepEqual(parseCommand("pin :low"), { kind: "pin", target: { effort: "low" } })
    assert.equal(parseCommand("pin banana").kind, "error")
    assert.deepEqual(parseCommand("opus"), { kind: "pin", target: { model: "opus" } })
    assert.deepEqual(parseCommand("auto"), { kind: "auto" })
    assert.deepEqual(parseCommand("off"), { kind: "off" })
    assert.deepEqual(parseCommand("feedback under needed opus"), { kind: "feedback", verdict: "under", note: "needed opus" })
    assert.deepEqual(parseCommand("feedback ok"), { kind: "feedback", verdict: "ok" })
    assert.equal(parseCommand("feedback maybe").kind, "error")
    assert.equal(parseCommand("frobnicate").kind, "error")
  })
})

describe("native /effort", () => {
  test("the first effort seen is the baseline", () => {
    assert.deepEqual(trackNativeEffort({}, "medium"), { baseline: "medium" })
  })

  test("a change is honoured until the engine returns to the baseline", () => {
    let s = trackNativeEffort({ baseline: "medium" }, "low")
    assert.deepEqual(s, { baseline: "medium", native: "low", change: "set" })
    s = trackNativeEffort(s, "low")
    assert.equal(s.native, "low")
    assert.equal(s.change, undefined)
    s = trackNativeEffort(s, "high")
    assert.deepEqual(s, { baseline: "medium", native: "high", change: "set" })
    s = trackNativeEffort(s, "medium")
    assert.deepEqual(s, { baseline: "medium", change: "cleared" })
  })

  test("a model without effort changes nothing", () => {
    assert.deepEqual(trackNativeEffort({ baseline: "medium", native: "low" }, undefined), { baseline: "medium", native: "low" })
  })
})
