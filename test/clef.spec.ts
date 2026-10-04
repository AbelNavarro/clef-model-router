import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  buildRequestBody,
  classifyHttpFailure,
  clefProvider,
  endpoint,
  levelProbabilities,
  parseResponse,
  topLevel,
  truncatePrompt,
  type ClefOptions,
  type HttpLike,
} from "../hooks/lib/clef.ts"
import { DEFAULT_RUBRIC } from "../hooks/lib/rubric.ts"

/** A Workers AI success envelope shaped like the published output schema. */
function envelope(answers: Record<string, unknown>, usage = { input_tokens: 412, output_tokens: 0 }) {
  return JSON.stringify({ result: { model: "clef-flash", answers, usage }, success: true, errors: [], messages: [] })
}

const SCORE_ANSWER = {
  type: "score",
  score: 2.9,
  legend: { "0": "Trivial", "1": "Simple", "2": "Moderate", "3": "Hard", "4": "Very hard" },
  probabilities: { "0": 0.01, "1": 0.04, "2": 0.15, "3": 0.7, "4": 0.1 },
  confidence: 0.7,
}

function provider(fetch: HttpLike, extra: Partial<ClefOptions> = {}) {
  let clock = 0
  return clefProvider({
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: "SECRET_TOKEN_abcdefghijklmnopqrstuvwxyz0123",
    model: "clef-flash",
    rubric: DEFAULT_RUBRIC,
    timeoutMs: 1500,
    maxPromptChars: 6000,
    fetch,
    // Fake time: a sleep advances the clock and resolves at once, unless aborted first.
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"))
        setTimeout(() => {
          if (signal.aborted) return reject(new Error("aborted"))
          clock += ms
          resolve()
        }, 5)
      }),
    now: () => clock,
    ...extra,
  })
}

describe("request", () => {
  test("endpoint uses the full model ID", () => {
    assert.equal(endpoint("acc", "clef-flash"), "https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef-flash")
    assert.equal(endpoint("acc", "clef", "https://example.test/v4/"), "https://example.test/v4/accounts/acc/ai/run/@cf/cloudflare/clef")
  })

  test("the body carries the model selector, the prompt as state, and typed questions", () => {
    const body = JSON.parse(buildRequestBody("Fix the typo", { model: "clef-flash", rubric: DEFAULT_RUBRIC, maxPromptChars: 6000 }))
    assert.equal(body.model, "clef-flash")
    assert.equal(body.state, "Fix the typo")
    assert.equal(body.questions.difficulty.type, "score")
    assert.equal(body.questions.difficulty.criteria.length, 5)
    assert.equal(body.questions.follow_up.type, "noul")
    assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"])
  })

  test("long prompts keep head and tail only", () => {
    const text = "A".repeat(5000) + "B".repeat(5000)
    const cut = truncatePrompt(text, 1000)
    assert.ok(cut.length < 1100)
    assert.ok(cut.startsWith("A".repeat(750)))
    assert.ok(cut.endsWith("B".repeat(250)))
    assert.match(cut, /9000 characters omitted/)
    assert.equal(truncatePrompt("short", 1000), "short")
  })
})

describe("response parsing", () => {
  test("a score answer becomes a recommendation with all five probabilities", () => {
    const r = parseResponse(envelope({ difficulty: SCORE_ANSWER, follow_up: { type: "noul", noul: 0.12 } }), {
      provider: "clef-flash",
      rubric: DEFAULT_RUBRIC,
      latencyMs: 41,
    })
    assert.ok(r.ok)
    assert.equal(r.recommendation.level, "hard")
    // The threshold works on the probability of the chosen level; Clef's own
    // confidence figure is kept beside it.
    assert.equal(r.recommendation.confidence, 0.7)
    assert.equal(r.recommendation.providerConfidence, 0.7)
    assert.equal(r.recommendation.score, 2.9)
    assert.equal(r.recommendation.contextDependent, 0.12)
    assert.equal(r.recommendation.inputTokens, 412)
    assert.equal(r.recommendation.latencyMs, 41)
    assert.equal(r.recommendation.probabilities.deep, 0.1)
  })

  test("a choice answer keyed by level name parses too", () => {
    const r = parseResponse(
      envelope({
        difficulty: {
          type: "choice",
          choice: "trivial",
          probabilities: { trivial: 0.8, simple: 0.1, standard: 0.05, hard: 0.05, deep: 0 },
          confidence: 0.8,
        },
      }),
      { provider: "clef", rubric: DEFAULT_RUBRIC, latencyMs: 200 },
    )
    assert.ok(r.ok)
    assert.equal(r.recommendation.level, "trivial")
    assert.equal(r.recommendation.contextDependent, undefined)
  })

  test("a tie goes to the more capable level", () => {
    const p = levelProbabilities({ probabilities: { "0": 0, "1": 0.5, "2": 0.5, "3": 0, "4": 0 } }, DEFAULT_RUBRIC)
    assert.ok(p)
    assert.equal(topLevel(p), "standard")
  })

  for (const [name, body] of [
    ["not JSON", "<html>bad gateway</html>"],
    ["no result", JSON.stringify({ success: true })],
    ["no answers", JSON.stringify({ success: true, result: { model: "clef-flash" } })],
    ["no difficulty answer", envelope({ other: SCORE_ANSWER })],
    ["probabilities missing", envelope({ difficulty: { type: "score", score: 2, confidence: 0.5 } })],
    ["probabilities out of range", envelope({ difficulty: { ...SCORE_ANSWER, probabilities: { "0": 7, "1": -6 } } })],
    ["probabilities do not sum to 1", envelope({ difficulty: { ...SCORE_ANSWER, probabilities: { "0": 0.1, "1": 0.1 } } })],
    ["unknown level keys", envelope({ difficulty: { ...SCORE_ANSWER, probabilities: { "7": 1 } } })],
  ] as const) {
    test(`malformed: ${name}`, () => {
      const r = parseResponse(body, { provider: "clef-flash", rubric: DEFAULT_RUBRIC, latencyMs: 30 })
      assert.equal(r.ok, false)
      if (!r.ok) assert.equal(r.failure.kind, "malformed")
    })
  }

  test("confidence is the top probability, not Clef's entropy-like figure", () => {
    // Real clef-flash answer: 76% on standard came back with confidence 0.50.
    const answer = { ...SCORE_ANSWER, probabilities: { "0": 0.07, "1": 0.07, "2": 0.76, "3": 0.06, "4": 0.04 }, confidence: 0.5 }
    const r = parseResponse(envelope({ difficulty: answer }), { provider: "x", rubric: DEFAULT_RUBRIC, latencyMs: 1 })
    assert.ok(r.ok)
    assert.equal(r.recommendation.level, "standard")
    assert.equal(r.recommendation.confidence, 0.76)
    assert.equal(r.recommendation.providerConfidence, 0.5)
  })

  test("a Clef confidence outside 0..1 is dropped", () => {
    const r = parseResponse(envelope({ difficulty: { ...SCORE_ANSWER, confidence: 3 } }), { provider: "x", rubric: DEFAULT_RUBRIC, latencyMs: 1 })
    assert.ok(r.ok)
    assert.equal(r.recommendation.providerConfidence, undefined)
  })
})

describe("errors", () => {
  test("daily free allocation exhausted (3036) is a quota failure", () => {
    const f = classifyHttpFailure(429, JSON.stringify({ success: false, errors: [{ code: 3036, message: "You have used up your daily free allocation of 10,000 neurons." }] }), 80)
    assert.equal(f.kind, "quota")
  })

  test("capacity (3040) is a rate limit, not quota", () => {
    const f = classifyHttpFailure(429, JSON.stringify({ success: false, errors: [{ code: 3040, message: "Capacity temporarily exceeded, please try again." }] }), 80)
    assert.equal(f.kind, "rate-limited")
  })

  test("401, 403 and code 10000 are auth failures", () => {
    assert.equal(classifyHttpFailure(401, "", 1).kind, "auth")
    assert.equal(classifyHttpFailure(403, "{}", 1).kind, "auth")
    assert.equal(classifyHttpFailure(400, JSON.stringify({ errors: [{ code: 10000, message: "Authentication error" }] }), 1).kind, "auth")
  })

  test("5xx is a server failure, other 4xx a bad request, 408 a timeout", () => {
    assert.equal(classifyHttpFailure(502, "<html>", 1).kind, "server")
    assert.equal(classifyHttpFailure(400, JSON.stringify({ errors: [{ code: 7003, message: "Invalid request headers" }] }), 1).kind, "bad-request")
    assert.equal(classifyHttpFailure(408, "", 1).kind, "timeout")
  })

  test("error messages never carry the token or account ID", () => {
    const token = "SECRET_TOKEN_abcdefghijklmnopqrstuvwxyz0123"
    const f = classifyHttpFailure(400, JSON.stringify({ errors: [{ code: 7000, message: `bad header Authorization: Bearer ${token} for account 0123456789abcdef0123456789abcdef` }] }), 1, [token])
    assert.ok(!f.message.includes(token))
    assert.ok(!f.message.includes("0123456789abcdef0123456789abcdef"))
  })
})

describe("provider", () => {
  test("not configured makes no request", async () => {
    let called = false
    const p = provider(async () => ((called = true), { status: 200, ok: true, text: "" }), { apiToken: undefined })
    const r = await p.decide("x")
    assert.equal(called, false)
    assert.ok(!r.ok && r.failure.kind === "not-configured")
  })

  test("sends the token only in the Authorization header", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined
    const p = provider(async (url, init) => {
      seen = { url, headers: init.headers, body: init.body }
      return { status: 200, ok: true, text: envelope({ difficulty: SCORE_ANSWER }) }
    })
    const r = await p.decide("Debug the deadlock")
    assert.ok(r.ok)
    assert.equal(seen?.headers.Authorization, "Bearer SECRET_TOKEN_abcdefghijklmnopqrstuvwxyz0123")
    assert.ok(!seen?.url.includes("SECRET"))
    assert.ok(!seen?.body.includes("SECRET"))
  })

  test("a slow answer times out and the late answer is ignored", async () => {
    const p = provider(() => new Promise((resolve) => setTimeout(() => resolve({ status: 200, ok: true, text: envelope({ difficulty: SCORE_ANSWER }) }), 200)))
    const r = await p.decide("x")
    assert.ok(!r.ok)
    if (!r.ok) {
      assert.equal(r.failure.kind, "timeout")
      assert.equal(r.failure.latencyMs, 1500)
    }
  })

  test("a fast answer beats the timeout", async () => {
    const p = provider(async () => ({ status: 200, ok: true, text: envelope({ difficulty: SCORE_ANSWER }) }))
    const r = await p.decide("x")
    assert.ok(r.ok)
  })

  test("a network error is classified and redacted", async () => {
    const p = provider(async () => {
      throw new Error("connect ECONNREFUSED with Bearer SECRET_TOKEN_abcdefghijklmnopqrstuvwxyz0123")
    })
    const r = await p.decide("x")
    assert.ok(!r.ok)
    if (!r.ok) {
      assert.equal(r.failure.kind, "network")
      assert.ok(!r.failure.message.includes("SECRET"))
    }
  })

  test("an HTTP error is classified", async () => {
    const p = provider(async () => ({ status: 429, ok: false, text: JSON.stringify({ success: false, errors: [{ code: 3036, message: "daily free allocation" }] }) }))
    const r = await p.decide("x")
    assert.ok(!r.ok && r.failure.kind === "quota")
  })
})
