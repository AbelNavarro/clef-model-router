// Runs a prompt corpus through Clef and shows, per prompt, what Clef said,
// what the router would do with it, and how that compares with the label.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run calibrate
//   npm run calibrate -- --model both --style both      compare clef / clef-flash, score / choice
//   npm run calibrate -- --rubric my-rubric.json         try a different rubric
//   npm run calibrate -- --mock                          offline: fake answers, to see the output
//   npm run calibrate -- --json > results.json           machine-readable
//   npm run calibrate -- --min-within 0.9                exit 1 if fewer route within one level of the label
//
// Calls are made one at a time so latency is measured honestly; each call
// counts toward the account's Workers AI usage (~400-1,500 input tokens).

import { readFileSync } from "node:fs"

import { parseConfig } from "../hooks/lib/config.ts"
import { buildRequestBody, CLEF_MODELS, type ClefModel } from "../hooks/lib/clef.ts"
import { NEURONS_PER_M_INPUT } from "../hooks/lib/guard.ts"
import { FIRST_PARTY_ENV } from "../hooks/lib/models.ts"
import { decide } from "../hooks/lib/policy.ts"
import type { QuestionStyle } from "../hooks/lib/rubric.ts"
import { LEVELS, type DecisionProvider, type Level, type ProviderResult } from "../hooks/lib/types.ts"
import { arg, credentials, flag, loadRubric, realProvider } from "./common.ts"

type Item = { prompt: string; expected?: Level; note?: string }

const corpusPath = arg("corpus", new URL("../corpus/prompts.jsonl", import.meta.url).pathname)!
const items: Item[] = readFileSync(corpusPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Item)
const limit = Number(arg("limit", "0"))
const corpus = limit > 0 ? items.slice(0, limit) : items

const models: ClefModel[] = arg("model", "clef-flash") === "both" ? [...CLEF_MODELS] : [arg("model", "clef-flash") as ClefModel]
const styles: QuestionStyle[] = arg("style", "score") === "both" ? ["score", "choice"] : [arg("style", "score") as QuestionStyle]
for (const m of models) if (!(CLEF_MODELS as readonly string[]).includes(m)) throw new Error(`--model must be clef-flash, clef or both`)
const rubric = loadRubric(arg("rubric"))
const asJson = flag("json")
const mock = flag("mock")
const config = parseConfig({}).config

/** Offline stand-in: answers near the label, with some noise, so the output can be seen without credentials. */
function mockProvider(model: string): DecisionProvider {
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  return {
    name: `${model} (mock)`,
    async decide(prompt: string): Promise<ProviderResult> {
      const label = corpus.find((c) => c.prompt.startsWith(prompt.slice(0, 40)))?.expected ?? "standard"
      const shift = rand() < 0.2 ? (rand() < 0.5 ? -1 : 1) : 0
      const center = Math.max(0, Math.min(4, LEVELS.indexOf(label) + shift))
      const probabilities = Object.fromEntries(LEVELS.map((l, i) => [l, Math.exp(-2 * Math.abs(i - center))])) as Record<Level, number>
      const total = LEVELS.reduce((s, l) => s + probabilities[l], 0)
      for (const l of LEVELS) probabilities[l] /= total
      const level = LEVELS[center]!
      return { ok: true, recommendation: { provider: `${model}-mock`, level, confidence: probabilities[level], probabilities, latencyMs: Math.round(30 + rand() * 30), inputTokens: Math.round(buildRequestBody(prompt, { model: "clef-flash", rubric, maxPromptChars: 6000 }).length / 4) } }
    },
  }
}

const SPARK = "▁▂▃▄▅▆▇█"
const spark = (p: Record<Level, number>) => LEVELS.map((l) => SPARK[Math.min(7, Math.floor(p[l] * 8))]).join("")
const short = (l: Level | undefined) => (l ?? "—").padEnd(8)

function quantile(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!
}

const creds = credentials()
if (!mock && !creds) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (environment only), or pass --mock.")
  process.exit(2)
}

const minWithin = Number(arg("min-within", "0"))
let gateFailed = false
const results: unknown[] = []
for (const model of models) {
  for (const style of styles) {
    const provider = mock ? mockProvider(model) : realProvider(creds!, { model, style, rubric })
    if (!asJson) {
      console.log(`\n${provider.name} · ${style} questions · ${corpus.length} prompts${mock ? " · MOCK ANSWERS" : ""}`)
      console.log("    ms  clef      conf  dist(t s m h d)  route     label       prompt")
    }
    const latencies: number[] = []
    const tokens: number[] = []
    let exact = 0
    let within = 0
    let under = 0
    let over = 0
    let failures = 0
    let labelled = 0
    for (const item of corpus) {
      const result = await provider.decide(item.prompt)
      const d = decide({ turnId: "cal", kind: "prompt", config, modelEnv: FIRST_PARTY_ENV, session: { mode: "auto", unavailable: [] }, result, now: 0, cacheTtlMs: 0 })
      const routed = d.final?.level
      if (!result.ok) {
        failures++
        if (!asJson) console.log(`  ${String(result.failure.latencyMs).padStart(4)}  ✕ ${result.failure.kind}: ${result.failure.message}`)
        results.push({ model, style, prompt: item.prompt, expected: item.expected, failure: result.failure })
        continue
      }
      const r = result.recommendation
      latencies.push(r.latencyMs)
      if (r.inputTokens !== undefined) tokens.push(r.inputTokens)
      let verdict = ""
      if (item.expected && routed) {
        labelled++
        const delta = LEVELS.indexOf(routed) - LEVELS.indexOf(item.expected)
        if (delta === 0) exact++
        if (Math.abs(delta) <= 1) within++
        if (delta < 0) under++
        if (delta > 0) over++
        verdict = delta === 0 ? "✓" : delta < 0 ? "↓" : "↑"
      }
      if (!asJson) {
        const text = item.prompt.replace(/\s+/g, " ").slice(0, 60)
        console.log(`  ${String(r.latencyMs).padStart(4)}  ${short(r.level)}  ${r.confidence.toFixed(2).slice(1)}  ${spark(r.probabilities)}           ${short(routed)}  ${short(item.expected)}${verdict}  ${text}`)
      }
      results.push({ model, style, prompt: item.prompt, expected: item.expected, recommendation: r, routed, adjustments: d.adjustments })
    }
    if (minWithin > 0 && labelled > 0 && within / labelled < minWithin) gateFailed = true
    if (!asJson) {
      const meanTokens = tokens.length ? tokens.reduce((s, x) => s + x, 0) / tokens.length : 0
      const neuronsPerCall = (meanTokens / 1e6) * (NEURONS_PER_M_INPUT[model] ?? 0)
      console.log(
        [
          "",
          `  labelled ${labelled}: exact ${exact} (${pct(exact, labelled)}) · within one level ${within} (${pct(within, labelled)}) · under-routed ${under} · over-routed ${over} · failures ${failures}`,
          `  latency mean ${Math.round(latencies.reduce((s, x) => s + x, 0) / Math.max(1, latencies.length))} ms · p50 ${Math.round(quantile(latencies, 0.5))} ms · p95 ${Math.round(quantile(latencies, 0.95))} ms (includes your network round trip)`,
          `  input tokens/call ~${Math.round(meanTokens)} · ~${neuronsPerCall.toFixed(1)} neurons/call · ~${neuronsPerCall > 0 ? Math.floor(10_000 / neuronsPerCall) : "∞"} calls/day in the 10,000-neuron free allocation (estimate)`,
          "  ↓ = routed below the label (risk: too weak) · ↑ = above (cost) · route = after the default confidence policy",
        ].join("\n"),
      )
    }
  }
}
if (asJson) console.log(JSON.stringify(results, null, 2))
if (gateFailed) {
  console.error(`calibrate: fewer than ${Math.round(minWithin * 100)}% of labelled prompts routed within one level`)
  process.exit(1)
}

function pct(n: number, d: number) {
  return d === 0 ? "—" : `${Math.round((100 * n) / d)}%`
}
