import { parseConfig, type Config } from "../hooks/lib/config.ts"
import { FIRST_PARTY_ENV } from "../hooks/lib/models.ts"
import type { PolicyInput, PolicySession } from "../hooks/lib/policy.ts"
import { LEVELS, type Level, type ProviderResult, type Recommendation } from "../hooks/lib/types.ts"

export function config(options: Record<string, unknown> = {}): Config {
  const { config, problems } = parseConfig({ cloudflare_account_id: "acct", cloudflare_api_token: "tok", ...options })
  if (problems.length > 0) throw new Error(`unexpected config problems: ${problems.join("; ")}`)
  return config
}

/** A recommendation with `p` on `level` and the rest spread over its neighbours. */
export function rec(level: Level, confidence = 0.9, extra: Partial<Recommendation> = {}): Recommendation {
  const probabilities = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>
  probabilities[level] = confidence
  const i = LEVELS.indexOf(level)
  const neighbour = LEVELS[i + 1] ?? LEVELS[i - 1]!
  probabilities[neighbour] = 1 - confidence
  return { provider: "clef-flash", level, confidence, probabilities, latencyMs: 42, inputTokens: 400, ...extra }
}

export function ok(r: Recommendation): ProviderResult {
  return { ok: true, recommendation: r }
}

export function session(extra: Partial<PolicySession> = {}): PolicySession {
  return { mode: "auto", unavailable: [], ...extra }
}

export function input(extra: Partial<PolicyInput> = {}): PolicyInput {
  return {
    turnId: "t1",
    kind: "prompt",
    config: config(),
    modelEnv: FIRST_PARTY_ENV,
    session: session(),
    now: 1_000_000,
    cacheTtlMs: 5 * 60_000,
    billing: "subscription",
    ...extra,
  }
}
