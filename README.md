# clef-model-router

A Claude Code mod that picks the **Claude model and reasoning effort for each turn**, using [Cloudflare Clef](https://blog.cloudflare.com/clef-decision-models/) as the decision model.

You keep using Claude Code as usual. When you send a prompt, the mod asks Clef-flash how much capability the request needs. It then runs that turn on the cheapest configuration that should be enough:

```
Fix the spelling of "recieve" in README.md.                         Clef → Haiku · 94%
Add pagination to /orders following the other list endpoints.       Clef → Sonnet · medium · 81%
Debug why these tests intermittently deadlock only in parallel.     Clef → Opus · high · 72%
Study this subsystem, find why it cascades under partitions, ...    Clef → Opus · xhigh · 88%
```

Routing is an optimization. If Clef is slow, down, unconfigured or out of free quota, the turn still runs on a deterministic fallback. Claude Code always keeps working.

> **Status: v0.1.** The mod, the policy and the failure paths are tested against Claude Code 2.1.289's own test host, and in live Claude Code sessions with a mock Workers AI endpoint. The examples above show the output format; they are not measured Clef results. Run `npm run calibrate` with your own credentials to see real ones (see [Calibration](docs/CALIBRATION.md)).

## Why

High-capability models and high effort are worth it for difficult debugging, architecture and unfamiliar code. They are wasted on a rename. Nobody switches `/model` and `/effort` before every prompt, so this mod does it for you, once per turn, using a decision model built for exactly this kind of typed judgment.

The goal is not "always the cheapest model". It is **the least expensive configuration that is sufficiently capable**, with every policy decision shown to you.

## Requirements

- Claude Code **2.1.287 or later** (mods are on by default from that version). Check with `claude --version`.
- A Cloudflare account. The Workers AI free allocation (10,000 neurons/day) is enough for normal personal use. See [Cost](#cost).

## Install

```sh
claude plugin marketplace add AbelNavarro/clef-claude-router
claude plugin install clef-model-router@clef-model-router
```

Then give it your Cloudflare credentials. In Claude Code:

```
/plugin configure clef-model-router@clef-model-router
```

- **Cloudflare account ID** and **API token**: in the [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/ai/workers-ai), open **Workers AI → Use REST API**, copy the Account ID, then **Create a Workers AI API Token**. The token is masked when you type it and is stored in your system's secure credential store, not in `settings.json`.

If the mod is already loaded, run `/reload-plugins`; otherwise start a new session. You should see `Clef ready · clef-flash` under the prompt.

To uninstall: `claude plugin uninstall clef-model-router@clef-model-router`. To stop it without uninstalling, use `/clef off` (this session) or set **Routing enabled** to off in `/config`.

<details>
<summary>Try it for one session without installing</summary>

```sh
git clone https://github.com/AbelNavarro/clef-claude-router
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... claude --plugin-dir ./clef-claude-router
```

Credentials in environment variables are inherited by every command Claude runs, so prefer `/plugin configure` for regular use.
</details>

## What you see

- **Under the prompt**, a one-line status for the current turn: `Clef → Sonnet · medium · 87%`. That is Clef's confidence in the difficulty level it picked. When policy changed Clef's pick, the reason follows in brackets, for example `(held for cache)` or `(unsure)`. When Clef could not answer: `Clef ✕ timeout → Sonnet · medium`.
- **`/clef`** shows the full picture: mode, the last decision with Clef's full probability distribution, latency, every policy adjustment and why, today's Clef usage, and the cache state.

```
Last turn
  route     Opus · high  (claude-opus-5-5, profile hard)
  source    clef
  clef      clef-flash: hard · confidence 72% · score 2.88/4 · follow-up 4% · 50 ms · 431 tokens
    trivial   ····················   1%
    simple    █···················   3%
    standard  ███·················  16%
    hard      ██████████████······  72%  ← Clef
    deep      ██··················   8%
```

| Command | |
| --- | --- |
| `/clef` | Status and the last decision |
| `/clef history` | This session's turns: latency, route, confidence, source, and any policy change |
| `/clef stats [days]` | Totals from the local log: by model, effort, profile, source; latency; fallbacks; overrides; cache holds; your feedback |
| `/clef test <prompt>` | Ask Clef about a prompt without sending it to Claude |
| `/clef profiles` | What each difficulty level runs on here |
| `/clef pin <target>` | Use one target for the rest of the session (`/clef pin opus:high`, `/clef pin hard`, `/clef pin :low`) |
| `/clef auto` | Unpin, resume after a `/model` change, and hand effort back to Clef after `/effort` |
| `/clef off` · `/clef on` | Stop or resume routing for this session |
| `/clef feedback under\|ok\|over [note]` | Rate the last route, for later analysis of whether Clef was right |

**One turn only:** start a prompt with `+target`. The prefix is removed before Claude sees the prompt.

```
+opus:max why does this deadlock only on ARM?
+haiku list the files in src/
+off explain this stack trace          (this turn runs exactly as Claude Code would)
```

## How it decides

```
prompt ──► turn.start ──► Clef-flash: difficulty 0-4 (+ "is this a follow-up?")   one call, ~40 ms model time
                  │
                  ▼
           policy (deterministic): overrides → continuation → confidence → follow-up floor
                                   → availability → context window → cache hold → effort clamp
                  │
                  ▼
           turn.step ×N: every main-loop request of the turn sent with that model + effort
```

- **Clef judges; code decides.** Clef answers one semantic question: how demanding is this request, on a five-level rubric. Overrides, failures, unavailable models, context windows, cache economics and effort limits are all deterministic rules. See [Architecture](docs/ARCHITECTURE.md).
- **Once per turn.** A turn may make many model requests (one after each tool result). The decision is made once and reused for all of them, so Clef's latency is paid once and the model never changes mid-turn. A go-ahead (`yes, do it`, `continue`) and background-task notifications reuse the last route without calling Clef.
- **Profiles, not free combinations.** Clef picks one of five difficulty levels, and each maps to a model and effort you can change:

  | Level | Default | For |
  | --- | --- | --- |
  | trivial | `haiku` | typo, rename, format, quick lookup |
  | simple | `sonnet:low` | small, well-specified change in one place |
  | standard | `sonnet:medium` | ordinary feature or bug work |
  | hard | `opus:high` | tricky debugging, refactors, unfamiliar code |
  | deep | `opus:xhigh` | open-ended investigation and design |

  Haiku 4.5 takes no effort setting, so the trivial level sends none.
- **Cache-aware.** Each model has its own prompt cache. Moving a long, warm conversation to a cheaper model re-reads all of it uncached, which can cost more than it saves. On a downgrade where at least 40k tokens are cached and the cache is still warm, the mod keeps the current model and changes only the effort. On Opus 5.5, Sonnet 5.5 and Fable 5.1, changing effort keeps the cache. Upgrades are never held back.
- **Low confidence** (below 55%): by default the mod takes the more capable of Clef's two likeliest levels. This is configurable.
- **You stay in control.** `+target` beats `/clef pin`, which beats Clef. A `/model` change mid-session pauses routing until `/clef auto`. An `/effort` change sets the effort while Clef keeps choosing the model. Subagents keep their own models.

## Cost

Routing itself runs on your Cloudflare account. Clef-flash costs **$0.09 per million input tokens** and has no charged output. One routing call sends about **500 input tokens** for a typical prompt (the rubric plus your prompt) and up to about 2,000 for a long one, since prompts are cut to 6,000 characters. That works out to roughly **4 neurons per call**, or about **2,000 routed prompts a day** inside Workers AI's free allocation of **10,000 neurons per day** (resets 00:00 UTC). These are estimates derived from Cloudflare's published prices; Clef is not yet in Cloudflare's per-model neuron table.

What happens at the limit depends on your Cloudflare plan ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)):

- **Workers Free:** requests beyond the allocation fail (error 3036). The mod notices, stops calling Clef until 00:00 UTC, and uses the fallback route. You are not billed.
- **Workers Paid:** usage beyond the allocation **is billed** at $0.011 per 1,000 neurons. To keep routing free, the mod has a local daily budget of 9,000 neurons (estimated), after which it stops calling Clef for the day. It counts only this mod's calls, not other Workers AI use on the account.

`/clef` shows today's calls, tokens and estimated neurons.

The mod also changes what you spend on Claude itself. That is the point, and `/clef stats` shows where your turns went.

## Privacy

For each prompt you type, the mod sends **that prompt's text** to Cloudflare Workers AI (cut to its first 4,500 and last 1,500 characters if longer than 6,000), along with the fixed rubric questions. Nothing else is sent: no conversation history, file contents, tool output, repository name or metadata. Go-aheads, task notifications, `+model` or `+profile` prompts, model pins and `/clef off` send nothing.

Everything else stays on your machine. The local log keeps a hash and the length of each prompt, not its text, unless you turn on **Log prompt text**. Cloudflare states that Workers AI does not use your inputs or outputs to train models, and the Clef announcement says Cloudflare does not read, store or train on Clef requests. Details and sources are in [docs/PRIVACY.md](docs/PRIVACY.md).

## Configuration

Everyday options are plugin options. Set them with `/plugin configure` or in `/config`: the Cloudflare account ID and token, the decision model (`clef-flash` or `clef`), the profiles, how to show the route, routing on or off, and whether to log prompt text. Tuning knobs go in an optional `~/.claude/clef-model-router.json`. Thresholds, policies, timeout, budget, cache hold and the rubric are all set there. The full reference, including precedence rules, is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md): lifecycle, policy pipeline, what was verified, design decisions, what was borrowed from earlier routers and what was left out
- [Configuration](docs/CONFIGURATION.md): every option, precedence, environment variables
- [Privacy and security](docs/PRIVACY.md): what leaves your machine, logs, credentials, Cloudflare's policies
- [Calibration](docs/CALIBRATION.md): the rubric, the prompt corpus, `npm run calibrate`, judging whether Clef was right
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security policy](SECURITY.md)

## Prior art

The earlier routers this project studied, and what it took from each, are listed in [Architecture → Prior art](docs/ARCHITECTURE.md#prior-art): [jev-model-router](https://github.com/satviksinha/jev-model-router), [jev-claude-router](https://github.com/Flam1ngFir3ball/jev-claude-router), [pi-auto-router](https://github.com/lucasamonrc/pi-auto-router), [clef-router](https://github.com/Gjusev/clef-router), [claude-code-model-router](https://github.com/nobodyohm-web/claude-code-model-router) and Morph's router.

## License

[Apache-2.0](LICENSE). Not affiliated with Anthropic or Cloudflare.
