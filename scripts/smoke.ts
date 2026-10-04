// Real-API smoke test: one Clef call with your credentials, checked against
// the published response schema. Skips (exit 0) without credentials.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run smoke
//   npm run smoke -- --model clef

import type { ClefModel } from "../hooks/lib/clef.ts"
import { DEFAULT_RUBRIC } from "../hooks/lib/rubric.ts"
import { arg, credentials, realProvider } from "./common.ts"

const creds = credentials()
if (!creds) {
  console.log("smoke: skipped (set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to run it)")
  process.exit(0)
}
const model = (arg("model", "clef-flash") ?? "clef-flash") as ClefModel
const provider = realProvider(creds, { model, style: "score", rubric: DEFAULT_RUBRIC, timeoutMs: 15_000 })

const cases = [
  { prompt: "Fix the spelling of \"recieve\" in README.md.", atMost: 2 },
  { prompt: "Study this subsystem, determine why its architecture causes cascading failures under partial network partitions, propose alternatives, implement the least disruptive fix, and verify it.", atLeast: 2 },
]
let failed = false
for (const c of cases) {
  const r = await provider.decide(c.prompt)
  if (!r.ok) {
    console.error(`smoke: FAILED ${r.failure.kind}${r.failure.status ? ` (HTTP ${r.failure.status})` : ""}: ${r.failure.message}`)
    process.exit(1)
  }
  const rec = r.recommendation
  const level = ["trivial", "simple", "standard", "hard", "deep"].indexOf(rec.level)
  const sane = (c.atMost === undefined || level <= c.atMost) && (c.atLeast === undefined || level >= c.atLeast)
  if (!sane) failed = true
  console.log(
    `smoke: ${model} ${rec.latencyMs} ms · ${rec.inputTokens ?? "?"} tokens · ${rec.level} (${Math.round(rec.confidence * 100)}%) ${sane ? "ok" : "UNEXPECTED"} · ${c.prompt.slice(0, 50)}`,
  )
}
process.exit(failed ? 1 : 0)
