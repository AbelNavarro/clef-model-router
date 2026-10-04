import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { buildRequestBody } from "../hooks/lib/clef.ts"
import { turnKind } from "../hooks/lib/overrides.ts"
import { DEFAULT_RUBRIC } from "../hooks/lib/rubric.ts"
import { LEVELS } from "../hooks/lib/types.ts"

const items = readFileSync(new URL("../corpus/prompts.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { prompt: string; expected: string })

test("the corpus covers every level with labelled prompts", () => {
  for (const item of items) assert.ok((LEVELS as readonly string[]).includes(item.expected), item.prompt)
  for (const level of LEVELS) assert.ok(items.filter((i) => i.expected === level).length >= 5, level)
})

test("every corpus prompt goes to Clef (none is mistaken for a go-ahead) and fits one request", () => {
  for (const item of items) {
    assert.equal(turnKind(item.prompt), "prompt", item.prompt)
    const body = buildRequestBody(item.prompt, { model: "clef-flash", rubric: DEFAULT_RUBRIC, maxPromptChars: 6000 })
    assert.ok(body.length < 13 * 1024 * 1024)
  }
})
