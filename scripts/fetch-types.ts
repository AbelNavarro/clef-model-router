// Downloads the mods API declarations Claude Code publishes, pinned to a
// commit, into .types/ for `npm run typecheck` (CI uses this). A Claude Code
// session that loads the mod also lays its own build's copy in
// .claude-plugin/types/; to check against that instead, copy its
// claude-code/index.d.ts over .types/claude-code.d.ts.

import { mkdirSync, writeFileSync } from "node:fs"

const COMMIT = "684800b206824dfd0cc8a876e8604b20f72c3617"
const url = `https://raw.githubusercontent.com/anthropics/claude-code/${COMMIT}/mods/types/claude-code.d.ts`
const response = await fetch(url)
if (!response.ok) {
  console.error(`fetch-types: HTTP ${response.status} for ${url}`)
  process.exit(1)
}
const text = await response.text()
mkdirSync(new URL("../.types/", import.meta.url), { recursive: true })
writeFileSync(new URL("../.types/claude-code.d.ts", import.meta.url), text)
console.log(`fetch-types: ${text.split("\n")[0]} → .types/claude-code.d.ts`)
