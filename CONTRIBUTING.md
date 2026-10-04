# Contributing

Thanks for helping. This project is deliberately small: a Claude Code mod that routes model and effort with Clef. Please read [Architecture](docs/ARCHITECTURE.md), and in particular what the project leaves out, before proposing larger features.

## Setup

```sh
git clone https://github.com/AbelNavarro/clef-model-router && cd clef-model-router
npm install
claude --plugin-dir .   # once: Claude Code lays its mod API declarations in .claude-plugin/types/
npm run types        # copy them to .types/ (falls back to the published, older copy)
npm run check        # typecheck (lib + mod), unit tests, claude plugin validate, claude plugin test
```

You need Node 22.18 or later, which runs TypeScript directly, and Claude Code 2.1.287 or later for `validate` and `test:mod`.

To try your working copy in a session, run `claude --plugin-dir .`. Saving a file reloads the mod when the current turn ends. CI type-checks the engine-independent code with `npm run typecheck`. The hooks module and engine tests are type-checked locally with `npm run typecheck:mod`, against your build's declarations. In CI they are exercised by `claude plugin validate` and `claude plugin test` on the latest Claude Code, because Anthropic's published declarations lag the current build.

## Layout

- `hooks/register.ts`: the only file that talks to the engine (`$`). Engine rules apply here:
  - `$` may only be passed to top-level functions;
  - environment variable names must be string literals;
  - no `import()`.
- `hooks/lib/*.ts`: pure logic with no engine dependency. Use only erasable TypeScript (no enums or namespaces), so Node can run it directly.
- `test/*.spec.ts`: unit tests (`npm test`).
- `tests/*.test.ts`: engine tests (`npm run test:mod`), with Cloudflare, the model and the filesystem stubbed.
- `corpus/prompts.jsonl`, `scripts/calibrate.ts`: routing calibration.

## Guidelines

- **Deterministic logic is tested.** A change to policy, parsing, config or failure handling comes with a unit test. A change to how hooks interact comes with an engine test.
- **Clef makes semantic judgments; code makes deterministic ones.** Don't ask Clef something a rule can answer.
- **Failures degrade, never block.** Every new path that can fail must end in "leave the request alone" or "use the fallback".
- **Privacy is a feature.** Nothing new leaves the machine without a strong reason. If it does, it is documented in [docs/PRIVACY.md](docs/PRIVACY.md) and off by default.
- **No runtime dependencies.** Dev dependencies are kept to TypeScript and Node types.
- **Rubric changes come with calibration output.** Include `npm run calibrate` results (real API) for the corpus, before and after.
- **Model tables.** When Claude Code changes what an alias resolves to, or which efforts a model takes, update `hooks/lib/models.ts` and its tests, citing the docs.

## Releases

1. Update `CHANGELOG.md`.
2. Bump `version` in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `package.json`.
3. Tag `vX.Y.Z`.

Users get the release with `claude plugin update clef-model-router@clef-model-router`.
