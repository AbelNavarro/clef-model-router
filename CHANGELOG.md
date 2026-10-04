# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The version in `.claude-plugin/plugin.json` is the release version; `claude plugin update` picks up a new one.

## [Unreleased]

## [0.1.3] - 2026-10-04

### Changed

- The route is shown dimmed at the end of the hint line under the prompt (`↳ Clef → …`), instead of in Claude Code's plugin status line, which prefixes a ⚠ that reads as a warning.

## [0.1.2] - 2026-10-04

### Fixed

- A reload with valid credentials now replaces a stale `Clef: not configured` status line when the session already has routed turns.

## [0.1.1] - 2026-10-04

### Fixed

- **The confidence threshold now compares the probability Clef gave its pick.** Before, it compared Clef's own `confidence` field, which live answers show is entropy-like and much lower (76% on one level reads about 50%). The low-confidence policy fired on almost every prompt as a result. The status line and `/clef` show the probability; Clef's figure is logged as `recommendation.clefConfidence`.

### Changed

- Docs state the end-to-end Clef latency measured live (0.3–0.5 s) and tokens per call (about 580). They also record the live cache measurements: an effort change kept the Opus 5.5 cache, and Sonnet 5.5 did not read the conversation cache across `-p` turns.
- `docs/CALIBRATION.md` documents the log format field by field, with tested `jq` queries for joining feedback to turns.

## [0.1.0] - 2026-10-04

First release.

### Added

- Per-turn routing in Claude Code via the mods API:
  - `turn.start` asks Cloudflare Clef-flash for a difficulty level;
  - `turn.step` sends every main-loop request of the turn with the chosen model and effort.
- Five configurable profiles: trivial, simple, standard, hard, deep. Each is `model[:effort]`, with alias resolution to full model IDs and effort clamped per model.
- Deterministic policy with a recorded reason for every change:
  - low-confidence policies;
  - a follow-up floor;
  - continuation of go-aheads and task notifications without a Clef call;
  - unavailable-model and context-window guards;
  - a cache-aware hold on downgrades;
  - effort cap and clamp.
- Explicit control:
  - `+target` one-turn prefix;
  - `/clef pin`, `auto`, `off`, `on`;
  - a `/model` change pauses routing;
  - `/effort` sets the effort while Clef keeps picking the model.
- Safe failure:
  - fallback profile on any Clef failure;
  - a routed request with no response stops routing for that turn;
  - engine fallbacks are never overridden;
  - circuit breaker, quota pause, and a local daily neuron budget.
- `/clef` status, `history`, `stats`, `profiles`, `test`, `feedback`.
- A status line under the prompt, or optionally a line under each answer.
- Local JSONL routing log, without prompt text by default.
- `npm run calibrate` over a labelled 48-prompt corpus: compares Clef and Clef-flash, and score and choice questions. `npm run smoke` makes one real-API call.
- Unit tests (`node --test`), engine tests (`claude plugin test`), and CI.
