// Shared by the developer scripts. They run under plain Node (>= 22.18, which
// strips TypeScript types natively) and reuse the mod's own modules, so what
// they measure is what the mod does.

import { readFileSync } from "node:fs"

import { clefProvider, type ClefModel } from "../hooks/lib/clef.ts"
import { DEFAULT_RUBRIC, parseRubric, type QuestionStyle, type Rubric } from "../hooks/lib/rubric.ts"
import type { DecisionProvider } from "../hooks/lib/types.ts"

export type Credentials = { accountId: string; apiToken: string }

/** Credentials come from the environment only, never from arguments. */
export function credentials(): Credentials | undefined {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  return accountId && apiToken ? { accountId, apiToken } : undefined
}

export function loadRubric(path: string | undefined): Rubric {
  if (!path) return DEFAULT_RUBRIC
  const parsed = parseRubric(readFileSync(path, "utf8"))
  if ("problems" in parsed) throw new Error(`rubric ${path}: ${parsed.problems.join("; ")}`)
  return parsed.rubric
}

export function realProvider(
  creds: Credentials,
  opts: { model: ClefModel; style: QuestionStyle; rubric: Rubric; timeoutMs?: number; maxPromptChars?: number },
): DecisionProvider {
  return clefProvider({
    accountId: creds.accountId,
    apiToken: creds.apiToken,
    model: opts.model,
    style: opts.style,
    rubric: opts.rubric,
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxPromptChars: opts.maxPromptChars ?? 6000,
    ...(process.env.CLEF_ROUTER_API_BASE ? { apiBase: process.env.CLEF_ROUTER_API_BASE } : {}),
    fetch: async (url, init) => {
      const r = await fetch(url, init)
      return { status: r.status, ok: r.ok, text: await r.text() }
    },
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms)
        signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true })
      }),
    now: () => performance.now(),
  })
}

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return process.argv[i + 1]
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
