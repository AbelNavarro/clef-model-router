import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DEFAULTS, parseAdvancedFile, parseConfig, parseProfile, splitTarget } from "../hooks/lib/config.ts"
import { cacheTtlMs, modelEnvFrom } from "../hooks/lib/env.ts"

describe("profiles", () => {
  test("model and optional effort", () => {
    assert.deepEqual(parseProfile("hard", "opus:high"), { level: "hard", model: "opus", effort: "high" })
    assert.deepEqual(parseProfile("trivial", "haiku"), { level: "trivial", model: "haiku" })
    assert.deepEqual(parseProfile("standard", " sonnet : default "), { level: "standard", model: "sonnet" })
  })

  test("provider IDs with colons stay whole", () => {
    assert.deepEqual(splitTarget("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), { model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" })
    assert.deepEqual(splitTarget("us.anthropic.claude-opus-x-v1:0:max"), { model: "us.anthropic.claude-opus-x-v1:0", effort: "max" })
  })

  test("invalid profiles are reported and replaced by the default", () => {
    assert.equal(typeof parseProfile("hard", "opus:extreme"), "string")
    assert.equal(typeof parseProfile("hard", ""), "string")
    const { config, problems } = parseConfig({ profile_hard: "opus:extreme" })
    assert.equal(problems.length, 1)
    assert.deepEqual(config.profiles.hard, { level: "hard", model: "opus", effort: "high" })
  })
})

describe("profiles list and advanced file", () => {
  test("one line lists the five profiles, lowest first", () => {
    const { config, problems } = parseConfig({ profiles: "haiku, haiku, sonnet:high, fable:high, fable:max" })
    assert.deepEqual(problems, [])
    assert.equal(config.profiles.simple.model, "haiku")
    assert.deepEqual(config.profiles.deep, { level: "deep", model: "fable", effort: "max" })
  })

  test("a list of the wrong length is reported and ignored", () => {
    const { config, problems } = parseConfig({ profiles: "haiku, opus" })
    assert.equal(problems.length, 1)
    assert.equal(config.profiles.trivial.model, "haiku")
    assert.equal(config.profiles.hard.model, "opus")
  })

  test("the advanced file is an object; a token in it is refused", () => {
    assert.deepEqual(parseAdvancedFile(undefined), { values: {}, problems: [] })
    assert.equal(parseAdvancedFile("[1]").problems.length, 1)
    assert.equal(parseAdvancedFile("{oops").problems.length, 1)
    const r = parseAdvancedFile(JSON.stringify({ timeout_ms: 800, cloudflare_api_token: "x" }))
    assert.deepEqual(r.values, { timeout_ms: 800 })
    assert.equal(r.problems.length, 1)
  })

  test("plugin options win over the advanced file", () => {
    const file = parseAdvancedFile(JSON.stringify({ decision_model: "clef", timeout_ms: 800 })).values
    const { config } = parseConfig({ ...file, decision_model: "clef-flash" })
    assert.equal(config.decisionModel, "clef-flash")
    assert.equal(config.timeoutMs, 800)
  })
})

describe("config", () => {
  test("defaults", () => {
    const { config, problems } = parseConfig({})
    assert.deepEqual(problems, [])
    assert.equal(config.enabled, true)
    assert.equal(config.decisionModel, "clef-flash")
    assert.equal(config.timeoutMs, DEFAULTS.timeoutMs)
    assert.equal(config.logPrompts, false)
    assert.equal(config.accountId, undefined)
  })

  test("out-of-range and unknown values fall back with a problem each", () => {
    const { config, problems } = parseConfig({ timeout_ms: 99_999, decision_model: "gpt", confidence_threshold: "x", max_effort: "ultra" })
    assert.equal(problems.length, 4)
    assert.equal(config.timeoutMs, DEFAULTS.timeoutMs)
    assert.equal(config.decisionModel, "clef-flash")
    assert.equal(config.maxEffort, undefined)
  })

  test("credentials fall back to the environment, options win", () => {
    assert.equal(parseConfig({}, { accountId: "env-acct", apiToken: "env-tok" }).config.apiToken, "env-tok")
    assert.equal(parseConfig({ cloudflare_api_token: "opt-tok" }, { apiToken: "env-tok" }).config.apiToken, "opt-tok")
  })

  test("max_effort none means no cap", () => {
    assert.equal(parseConfig({ max_effort: "none" }).config.maxEffort, undefined)
    assert.equal(parseConfig({ max_effort: "high" }).config.maxEffort, "high")
  })
})

describe("environment", () => {
  test("third-party providers and alias pins", () => {
    const env = modelEnvFrom({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.opus" })
    assert.equal(env.thirdParty, true)
    assert.equal(env.defaults.opus, "us.anthropic.opus")
    assert.equal(modelEnvFrom({ CLAUDE_CODE_USE_VERTEX: "0" }).thirdParty, false)
  })

  test("cache TTL follows Claude Code's order", () => {
    assert.equal(cacheTtlMs(0, {}), 60 * 60_000) // subscription
    assert.equal(cacheTtlMs(0, { ANTHROPIC_API_KEY: "set" }), 5 * 60_000)
    assert.equal(cacheTtlMs(0, { CLAUDE_CODE_USE_BEDROCK: "1" }), 5 * 60_000)
    assert.equal(cacheTtlMs(0, { ANTHROPIC_API_KEY: "set" }, "1h"), 60 * 60_000)
    assert.equal(cacheTtlMs(0, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }, "1h"), 5 * 60_000)
    assert.equal(cacheTtlMs(0, { FORCE_PROMPT_CACHING_5M: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }), 5 * 60_000)
    assert.equal(cacheTtlMs(0, { ANTHROPIC_API_KEY: "set", ENABLE_PROMPT_CACHING_1H: "1" }), 60 * 60_000)
    assert.equal(cacheTtlMs(15, { FORCE_PROMPT_CACHING_5M: "1" }), 15 * 60_000)
  })
})
