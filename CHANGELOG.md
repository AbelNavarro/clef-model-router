# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The version in `.claude-plugin/plugin.json` is the release version; `claude plugin update` picks up a new one.

## [Unreleased]

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
