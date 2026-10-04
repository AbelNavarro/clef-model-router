// Puts the mods API declarations in .types/ for `npm run typecheck:mod`.
//
// Preferred source: the copy your own Claude Code build lays beside the mod
// in .claude-plugin/types/ once it has loaded it (`claude --plugin-dir .`),
// which matches the engine you run. Fallback: the copy Anthropic publishes
// in the claude-code repository, pinned to a commit. The published copy can
// lag the current build (at this pin it predates `$.state`), which is why CI
// type-checks only the engine-independent code and leaves the hooks module
// to `claude plugin validate` and `claude plugin test` on the latest build.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

const target = new URL("../.types/claude-code.d.ts", import.meta.url)
mkdirSync(new URL("../.types/", import.meta.url), { recursive: true })

const laid = new URL("../.claude-plugin/types/claude-code/index.d.ts", import.meta.url)
if (existsSync(laid)) {
  copyFileSync(laid, target)
  console.log(`fetch-types: ${readFileSync(laid, "utf8").split("\n")[0]} (from .claude-plugin/types) → .types/claude-code.d.ts`)
  process.exit(0)
}

const COMMIT = "684800b206824dfd0cc8a876e8604b20f72c3617"
const url = `https://raw.githubusercontent.com/anthropics/claude-code/${COMMIT}/mods/types/claude-code.d.ts`
const response = await fetch(url)
if (!response.ok) {
  console.error(`fetch-types: HTTP ${response.status} for ${url}`)
  process.exit(1)
}
const text = await response.text()
writeFileSync(target, text)
console.log(`fetch-types: ${text.split("\n")[0]} (published copy) → .types/claude-code.d.ts`)
console.log("fetch-types: load the mod once with `claude --plugin-dir .` and rerun to check against your build.")
