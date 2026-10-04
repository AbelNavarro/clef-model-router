// Engine-level tests: the hooks module loaded by Claude Code's own test host
// (`claude plugin test`), with Cloudflare, the model and the filesystem
// stubbed. The pure logic has its own unit tests under test/.

import type { On } from "claude-code"
import { expect, mock, test, type Engine } from "claude-code/testing"

const T0 = Date.parse("2026-10-04T10:00:00Z")
const CREDS = { cloudflare_account_id: "acct", cloudflare_api_token: "tok-123456" }

type Seen = { model: string; effort?: unknown; index: number; agentId?: string }

/** A Workers AI answer putting `p` of the mass on level `level` (0..4). */
function clefAnswer(level: number, p = 0.82, followUp = 0.05): string {
  const probabilities: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 }
  probabilities[String(level)] = p
  probabilities[String(level === 4 ? 3 : level + 1)] = 1 - p
  return JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: {
      model: "clef-flash",
      answers: {
        difficulty: { type: "score", score: level, legend: {}, probabilities, confidence: p },
        follow_up: { type: "noul", noul: followUp },
      },
      usage: { input_tokens: 400, output_tokens: 0 },
    },
  })
}

type World = {
  steps: Seen[]
  fetches: { url: string; body: string; auth: string | undefined }[]
  statuses: (string | undefined)[]
  toasts: string[]
  files: Map<string, string>
  clock: ReturnType<typeof mock.clock>
}

function world(on: On, opts: { clef?: () => unknown; sessionModel?: () => string; stepFails?: (index: number) => boolean } = {}): World {
  const w: World = { steps: [], fetches: [], statuses: [], toasts: [], files: new Map(), clock: mock.clock(on, { now: T0 }) }
  mock.store(on)
  mock.env(on, { HOME: "/home/test" })
  on("settings.read", () => ({ value: {} }))
  on("session.start", () => ({ cwd: "/work" }))
  on("session.model", () => ({ value: opts.sessionModel?.() ?? "claude-opus-5-5" }))
  on("session.id", () => ({ value: "sess-1" }))
  on("session.usage", () => ({ value: { startedAt: T0, context: { tokens: 30_000, window: 1_000_000, percent: 3 }, rateLimits: [] } }))
  on("command.register", () => ({ value: { command: "clef" } }))
  // What the mod adds to the hint line under the prompt (via ui.render).
  on("ui.render", ($, e) => {
    const tail = (e.props as { tail?: string }).tail
    w.statuses.push(tail === undefined ? undefined : tail.replace(/^\s*↳ /, ""))
    return { type: "Text", props: {}, children: ["hint"] }
  })
  on("ui.toast", ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on("fs.read", ($, e) => (w.files.has(e.path) ? { value: w.files.get(e.path)! } : { deny: "ENOENT" }))
  on("fs.write", ($, e) => (w.files.set(e.path, e.text), { value: undefined }))
  on("fs.list", () => ({ value: [] }))
  on("http.fetch", ($, e) => {
    w.fetches.push({ url: e.url, body: e.init?.body ?? "", auth: e.init?.headers?.Authorization })
    return (opts.clef ?? (() => ({ value: { status: 200, ok: true, headers: {}, text: clefAnswer(3) } })))() as never
  })
  on("prompt.submit", ($, e) => ({ text: e.text }))
  on("turn.start", ($, e) => ({ turnId: e.turnId }))
  on("turn.complete", () => ({ text: "" }))
  on("turn.step", async function* ($, e) {
    w.steps.push({ model: e.model, effort: e.effort, index: e.index, ...(e.agentId ? { agentId: e.agentId } : {}) })
    const failed = opts.stepFails?.(e.index) ?? false
    return {
      turnId: e.turnId,
      index: e.index,
      answer: failed ? "" : "ok",
      toolUses: [],
      stopReason: failed ? null : "end_turn",
      usage: failed
        ? null
        : { model: e.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 100 },
    }
  })
  return w
}

async function step($: Engine, turnId: string, index: number, model = "claude-opus-5-5", extra: Record<string, unknown> = {}) {
  const stream = $.turn.step({ turnId, index, model, effort: "medium", messageCount: 3, ...extra })
  let r = await stream.next()
  while (r.done !== true) r = await stream.next()
  return r.value
}

/** Draws the hint line once and returns what the mod appended (without ↳). */
async function shown($: Engine, w: World): Promise<string | undefined> {
  await $.ui.render({ component: "PromptHint", surface: "terminal", props: { isDraft: false, isWorking: false, hint: "? for shortcuts" } } as never)
  return w.statuses.at(-1)
}

async function start($: Engine) {
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as never)
}

test("one Clef call per turn; every main-loop request of the turn gets the route", { options: CREDS }, async ($, on) => {
  const w = world(on)
  await start($)
  await $.turn.start({ turnId: "t1", text: "Debug why these tests intermittently deadlock only in parallel" })
  for (const i of [0, 1, 2]) await step($, "t1", i)
  expect(w.fetches.length).toBe(1)
  expect(w.fetches[0]!.url).toMatch(/\/accounts\/acct\/ai\/run\/@cf\/cloudflare\/clef-flash$/)
  expect(w.fetches[0]!.auth).toBe("Bearer tok-123456")
  expect(JSON.parse(w.fetches[0]!.body).state).toBe("Debug why these tests intermittently deadlock only in parallel")
  expect(w.steps.map((s) => `${s.model}:${String(s.effort)}`)).toEqual(["claude-opus-5-5:high", "claude-opus-5-5:high", "claude-opus-5-5:high"])
  expect(await shown($, w)).toBe("Clef → Opus · high · 82%")
})

test("subagent requests keep their own model", { options: CREDS }, async ($, on) => {
  const w = world(on, { clef: () => ({ value: { status: 200, ok: true, headers: {}, text: clefAnswer(0, 0.95) } }) })
  await start($)
  await $.turn.start({ turnId: "t1", text: "rename foo to bar" })
  await step($, "t1", 0, "claude-opus-5-5")
  await step($, "sub-turn", 0, "claude-sonnet-5-5", { agentId: "agent-1" })
  expect(w.steps[0]!.model).toBe("claude-haiku-4-5")
  expect(w.steps[0]!.effort).toBeUndefined()
  expect(w.steps[1]!.model).toBe("claude-sonnet-5-5")
})

test("a fallback model Claude Code picks mid-turn is never overridden", { options: CREDS }, async ($, on) => {
  const w = world(on)
  await start($)
  await $.turn.start({ turnId: "t1", text: "Investigate the cascading failure" })
  await step($, "t1", 0, "claude-opus-5-5")
  await step($, "t1", 1, "claude-opus-4-8")
  expect(w.steps[0]!.model).toBe("claude-opus-5-5")
  expect(w.steps[0]!.effort).toBe("high")
  expect(w.steps[1]!.model).toBe("claude-opus-4-8")
  expect(w.steps[1]!.effort).toBe("medium")
})

test("a routed request that gets no response stops routing for the rest of the turn", { options: CREDS }, async ($, on) => {
  const w = world(on, {
    clef: () => ({ value: { status: 200, ok: true, headers: {}, text: clefAnswer(0, 0.95) } }),
    stepFails: (i) => i === 0,
  })
  await start($)
  await $.turn.start({ turnId: "t1", text: "fix the typo in README" })
  await step($, "t1", 0)
  await step($, "t1", 1)
  expect(w.steps[0]!.model).toBe("claude-haiku-4-5")
  expect(w.steps[1]!.model).toBe("claude-opus-5-5")
})

test("a +target prefix routes one turn without asking Clef, and is removed from the prompt", { options: CREDS }, async ($, on) => {
  const w = world(on)
  await start($)
  const submitted = await $.prompt.submit({ text: "+sonnet:low what does this regex match?", wait: false } as never)
  expect((submitted as { text: string }).text).toBe("what does this regex match?")
  await $.turn.start({ turnId: "t1", text: "what does this regex match?" })
  await step($, "t1", 0)
  expect(w.fetches.length).toBe(0)
  expect(w.steps[0]!.model).toBe("claude-sonnet-5-5")
  expect(w.steps[0]!.effort).toBe("low")
  // The next turn is back to automatic.
  await $.turn.start({ turnId: "t2", text: "Debug the intermittent deadlock" })
  expect(w.fetches.length).toBe(1)
})

test("a go-ahead continues the last route with no Clef call", { options: CREDS }, async ($, on) => {
  const w = world(on)
  await start($)
  await $.turn.start({ turnId: "t1", text: "Plan the migration of the job queue" })
  await step($, "t1", 0)
  await $.turn.start({ turnId: "t2", text: "yes, do it" })
  await step($, "t2", 0)
  expect(w.fetches.length).toBe(1)
  expect(w.steps[1]!.model).toBe("claude-opus-5-5")
  expect(w.steps[1]!.effort).toBe("high")
})

test("when Clef is unreachable the turn runs on the fallback profile", { options: CREDS }, async ($, on) => {
  const w = world(on, { clef: () => ({ deny: "connect ECONNREFUSED" }) })
  await start($)
  await $.turn.start({ turnId: "t1", text: "Add pagination to the users endpoint" })
  await step($, "t1", 0)
  expect(w.steps[0]!.model).toBe("claude-sonnet-5-5")
  expect(w.steps[0]!.effort).toBe("medium")
  expect(await shown($, w)).toBe("Clef ✕ network → Sonnet · medium")
})

test("a Clef timeout falls back without waiting for the answer", { options: CREDS }, async ($, on) => {
  let w: World
  w = world(on, {
    clef: async () => {
      await w.clock.sleep(60_000)
      return { value: { status: 200, ok: true, headers: {}, text: clefAnswer(0) } }
    },
  })
  await start($)
  const started = $.turn.start({ turnId: "t1", text: "Explain this function" })
  await w.clock.advance(1600)
  await started
  await step($, "t1", 0)
  expect(w.steps[0]!.model).toBe("claude-sonnet-5-5")
  expect(await shown($, w)).toBe("Clef ✕ timeout → Sonnet · medium")
})

test("not configured: no request, one notice, the fallback route", {}, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await shown($, w)).toBe("Clef: not configured")
  await $.turn.start({ turnId: "t1", text: "Add pagination" })
  await $.turn.start({ turnId: "t2", text: "Add tests" })
  await step($, "t2", 0)
  expect(w.fetches.length).toBe(0)
  expect(w.toasts.length).toBe(1)
  expect(w.steps[0]!.model).toBe("claude-sonnet-5-5")
})

test("/clef off leaves turns alone; /clef on resumes", { options: CREDS }, async ($, on) => {
  const w = world(on)
  await start($)
  const off = await $.command.run({ command: "clef", args: "off" } as never)
  expect((off as { text: string }).text).toMatch(/Routing off/)
  await $.turn.start({ turnId: "t1", text: "Debug the deadlock" })
  await step($, "t1", 0, "claude-opus-5-5")
  expect(w.fetches.length).toBe(0)
  expect(w.steps[0]!.effort).toBe("medium")
  await $.command.run({ command: "clef", args: "on" } as never)
  await $.turn.start({ turnId: "t2", text: "Debug the deadlock" })
  expect(w.fetches.length).toBe(1)
})

test("a /model change mid-session pauses routing until /clef auto", { options: CREDS }, async ($, on) => {
  let sessionModel = "claude-opus-5-5"
  const w = world(on, { sessionModel: () => sessionModel })
  await start($)
  await $.turn.start({ turnId: "t1", text: "Debug the deadlock" })
  await step($, "t1", 0)
  sessionModel = "claude-sonnet-5-5"
  await $.turn.start({ turnId: "t2", text: "Debug the deadlock again" })
  await step($, "t2", 0, "claude-sonnet-5-5")
  expect(w.steps[1]!.model).toBe("claude-sonnet-5-5")
  expect(w.steps[1]!.effort).toBe("medium")
  expect(w.toasts.some((t) => t.includes("Clef paused"))).toBe(true)
  await $.command.run({ command: "clef", args: "auto" } as never)
  await $.turn.start({ turnId: "t3", text: "Debug the deadlock once more" })
  await step($, "t3", 0, "claude-sonnet-5-5")
  expect(w.steps[2]!.model).toBe("claude-opus-5-5")
})

test("/clef status explains the last decision with Clef's distribution", { options: CREDS }, async ($, on) => {
  world(on)
  await start($)
  await $.turn.start({ turnId: "t1", text: "Debug the deadlock" })
  const out = (await $.command.run({ command: "clef", args: "" } as never)) as { text: string }
  expect(out.text).toMatch(/mode\s+auto/)
  expect(out.text).toMatch(/token set/)
  expect(out.text).not.toMatch(/tok-123456/)
  expect(out.text).toMatch(/hard .*82%.*← Clef/)
})

test("each turn is logged locally without the prompt text", { options: CREDS }, async ($, on) => {
  const w = world(on)
  await start($)
  await $.turn.start({ turnId: "t1", text: "Debug the secret deadlock" })
  await step($, "t1", 0)
  await $.turn.complete({ turnId: "t1", answer: "done", durationMs: 1234, isAborted: false, reason: "answer" } as never)
  const [path, text] = [...w.files.entries()].find(([p]) => p.includes("routing-"))!
  expect(path).toBe("/home/test/.claude/plugins/data/clef-model-router/routing-2026-10-04-sess-1.jsonl")
  const record = JSON.parse(text.trim())
  expect(record.final.model).toBe("claude-opus-5-5")
  expect(record.recommendation.level).toBe("hard")
  expect(record.answered.model).toBe("claude-opus-5-5")
  expect(record.prompt).toBeUndefined()
  expect(text).not.toMatch(/secret/)
})

test("an /effort change sets effort while Clef keeps picking the model; it lifts when effort returns", { options: CREDS }, async ($, on) => {
  const w = world(on)
  await start($)
  await $.turn.start({ turnId: "t1", text: "Debug the deadlock" })
  await step($, "t1", 0, "claude-opus-5-5", { effort: "medium" })
  await $.turn.start({ turnId: "t2", text: "Debug the deadlock again" })
  await step($, "t2", 0, "claude-opus-5-5", { effort: "low" })
  await $.turn.start({ turnId: "t3", text: "And once more" })
  await step($, "t3", 0, "claude-opus-5-5", { effort: "medium" })
  expect(w.steps.map((s) => `${s.model}:${String(s.effort)}`)).toEqual(["claude-opus-5-5:high", "claude-opus-5-5:low", "claude-opus-5-5:high"])
  expect(w.toasts.some((t) => t.includes("using your effort low"))).toBe(true)
})

test("a reload with credentials replaces a stale 'not configured' status", { options: CREDS }, async ($, on) => {
  const w = world(on)
  await start($)
  await $.turn.start({ turnId: "t1", text: "Debug the deadlock" })
  await start($)
  expect(await shown($, w)).toBe("Clef → Opus · high · 82%")
})
