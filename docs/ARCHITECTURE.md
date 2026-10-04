# Architecture

## In one picture

```
 you type ──► prompt.submit ── "+target " prefix? → kept for this turn, removed from the prompt
                 │
                 ▼
             turn.start ──┬── turn kind: prompt / go-ahead / task notification / empty
                          ├── explicit choice or continuation?  → no Clef call
                          ├── guard: budget, quota, circuit breaker → may skip the call
                          ├── Clef (one HTTPS request, timeout 1.5 s) → Recommendation
                          └── policy(recommendation, session, overrides, cache) → Decision
                 │
                 ▼
             turn.step ×N  (one per model request of the turn; main loop only)
                          ├── step 0: note Claude Code's own model/effort (/model, /effort changes)
                          ├── engine fell back to another model mid-turn? → never override
                          ├── a routed request got no response? → stop routing this turn
                          └── next({ ...e, model, effort })  → usage recorded (cache state)
                 │
                 ▼
             turn.complete ── one JSON line in the local log
```

All of it lives in one hooks module, [`hooks/register.ts`](../hooks/register.ts). The module only wires events to the engine. The logic sits in plain modules under [`hooks/lib/`](../hooks/lib), which have no engine dependency, so they are unit-tested with `node --test`:

| Module | Role |
| --- | --- |
| `types.ts` | Shared types: `Recommendation` (what any decision backend returns), `Decision`, `Route`, `Target` |
| `rubric.ts` | The questions Clef is asked. This is the calibration surface |
| `clef.ts` | The Workers AI client: request, response parsing, error classification, timeout. Never throws |
| `policy.ts` | The deterministic policy: a pure function from what is known at the start of a turn to the route |
| `models.ts` | Alias resolution, effort support per model, windows, rank, cache behaviour of effort changes |
| `overrides.ts` | `+target` prefixes, `/clef` commands, go-ahead detection, native `/effort` tracking |
| `guard.ts` | Daily neuron budget, quota pause, circuit breaker |
| `config.ts` · `env.ts` | Plugin options and the advanced file → `Config`; environment → model and cache facts |
| `log.ts` · `format.ts` · `redact.ts` | Local log records and stats, everything shown, secret redaction |

## What was verified, and how

Everything below was checked against current documentation (October 2026) and, where the docs were silent, in a live Claude Code 2.1.289 session.

**Claude Code mods** ([overview](https://code.claude.com/docs/en/plugins/mods/overview), [events](https://code.claude.com/docs/en/plugins/mods/events), [reference](https://code.claude.com/docs/en/plugins/mods/reference))

- Mods need Claude Code 2.1.287 or later and are on by default. The `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` variable that earlier routers require is ignored from 2.1.287.
- `turn.start` fires once per turn, before its first model call, with the prompt text after `prompt.submit` settled it. Verified live: a decision made there applies to step 0.
- `turn.step` fires for every model request of a turn, main loop and subagents (`e.agentId`). `next({ ...e, model, effort })` rewrites the request; the turn, index and message count are pinned.
- **`turn.step` does not resolve model aliases.** Verified live: `model: "haiku"` fails with `unrecognized_model`, and `claude-haiku-4-5` works. The mod resolves aliases itself, honouring `ANTHROPIC_DEFAULT_*_MODEL`.
- After a request failed, the engine retried at step 1 on its own fallback model (seen live as `claude-sonnet-5`). A router that rewrites every step would override that fallback. This one never rewrites a step whose model differs from the turn's step 0.
- Sending `effort` to Haiku 4.5 is tolerated (the engine drops it), but the mod omits it anyway.
- Subagents get no `turn.start`. Their steps carry `agentId` and run on the model their definition gives them. Subagents that *inherit* the main model resolve it from the session model, not from a per-request rewrite, so they are not routed. This is a known limitation.
- `$.http.fetch` takes no abort signal. The timeout races the request against `$.clock.sleep`, and a late answer is ignored.
- `userConfig` fields marked `sensitive` are kept in the platform's secure credential store.
- `$` may only be passed to top-level functions in the module (`claude plugin validate` enforces this), which is why the module keeps its state at module level.

**Models and effort** ([model configuration](https://code.claude.com/docs/en/model-config))

- On the Anthropic API, the aliases resolve to `haiku → claude-haiku-4-5`, `sonnet → claude-sonnet-5-5`, `opus → claude-opus-5-5` and `fable → claude-fable-5-1`. Bedrock, Vertex and Foundry use other IDs.
- Effort levels: `low`, `medium`, `high`, `xhigh` and `max` on Fable 5.x, Opus 5.5, Sonnet 5.5, Opus 5, Sonnet 5, Opus 4.8 and 4.7. Opus and Sonnet 4.6 lack `xhigh`. **Haiku 4.5 takes no effort.** Claude Code clamps an unsupported level to the highest supported level below it, and the mod does the same before sending.
- Defaults: `medium` on Opus 5.5 and Sonnet 5.5, `high` on most others.

**Prompt caching** ([how Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching))

- Each model has its own cache. A model switch re-reads the whole conversation uncached.
- Changing effort keeps the cache on Opus 5.5, Sonnet 5.5 and Fable 5.1 with an API key or a subscription. It does not on other models, on Bedrock or Vertex, through a gateway, or with experimental betas disabled.
- **Measured live (Claude Code 2.1.289, subscription, `claude -p --continue`, ~42k-token conversation):**
  - Opus 5.5 high → low through the mod's rewrite: 42.5k read, 0.1k written. The cache was kept.
  - A model switch: only the shared ~8–10k system prefix was read.
  - Haiku routed from an Opus session cached normally across turns.
  - **Sonnet 5.5 never read the conversation from cache across turns, even in plain Claude Code with the router bypassed and the effort unchanged.** Each turn re-wrote it (~24–33k). The cause is unknown and may be specific to `-p`. The log records cache read and write per turn, so real sessions will show whether it holds interactively. If it does, routing long conversations to Sonnet costs more than the cache-hold rule assumes.
- The TTL is one hour on a subscription within plan usage, and five minutes with an API key or a cloud provider. It can be overridden by `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting and related variables. The mod resolves it the same way.
- The system-prompt prefix is shared across sessions per model. In a new session, a request on Haiku read about 17k tokens from cache.

**Clef on Workers AI** ([blog](https://blog.cloudflare.com/clef-decision-models/), [clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/), [clef](https://developers.cloudflare.com/workers-ai/models/clef/), [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [errors](https://developers.cloudflare.com/workers-ai/platform/errors/), [limits](https://developers.cloudflare.com/workers-ai/platform/limits/))

- Request: `POST /client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef-flash` with `Authorization: Bearer`. The body is `{ model, state, questions }` with 1 to 64 typed questions: `noul` (yes/no), `choice` (2 to 255 options) and `score` (an ordered rubric of 2 to 10 levels, indexed from 0).
- Response: `result.answers[id]`. A `score` answer carries the probability-weighted `score`, `legend`, `probabilities` (summing to 1) and `confidence`. **Clef's `confidence` is not the probability of the chosen level.** Live answers behave like 1 − normalised entropy: 47% on one level reads 20%, 76% reads 50%, 88% reads 73%. The router thresholds on the probability of the chosen level, which is what people read a percentage as, and logs Clef's figure beside it so a later analysis can tell which predicts mistakes better. A `choice` answer carries `choice`, `probabilities` and `confidence`. A `noul` answer carries the probability of yes. `usage` carries input and output tokens. The mod's parser follows the published JSON schemas.
- Latency (Cloudflare's figures): Clef-flash 38.8 ms median and 122 ms p95; Clef 209 ms median. Both models have a 64k context. Your network round trip comes on top.
- Price: $0.09 per million input tokens for Clef-flash and $0.24 for Clef, input only. The free allocation is 10,000 neurons per day across Workers AI, reset at 00:00 UTC. Error 3036 (HTTP 429) means the allocation is used up; 3040 (HTTP 429) means capacity. Text-generation models are limited to 300 requests per minute.
- Clef is open-weight (Apache-2.0) and compatible with the Jev API.

## Assumptions in the brief that did not hold

1. **"Fast model + low effort"**: the fast model (Haiku 4.5) has no effort parameter at all. The trivial profile sends no effort.
2. **"The mod alters model and effort"**: true, but only with full model IDs. Aliases have to be resolved by the mod.
3. **"Free allowance exhaustion fails rather than bills"**: this depends on the plan. On Workers Free it fails; on Workers Paid it is billed. The mod adds a local daily budget so both stay free by default.
4. **"Switching models destroys the cache, so routing must be cautious"**: for model switches, yes. For effort, not on the current flagship models. Effort can be routed freely there, which the cache policy uses.
5. **"A routing line in the reply"** (as earlier routers did): writing into the model's own text puts the line into the transcript the model re-reads. Mods have `$.ui.status` and a `turn.complete` line under the answer, and neither touches what the model reads.
6. **"`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is required"**: it is obsolete from 2.1.287.

## Design decisions

**Routing unit: the turn.** The decision is made in `turn.start`, where the person's text is, and reused for every `turn.step` of that turn. Asking per step would pay Clef's latency after every tool result, and could switch model in the middle of an agentic loop. A prompt typed into a running turn joins that turn and keeps its route.

**Profiles over a two-dimensional decision.** Clef could be asked two questions, "which model?" and "how much effort?". That doubles the rubric to calibrate and allows incoherent pairs such as Haiku with `max`. Asking for **one difficulty level** and mapping each level to a configured profile keeps calibration to one rubric. It also keeps every route valid and lets users reshape the ladder (for example `fable:high` for deep) without touching the rubric. The effort dimension is not lost: the cache policy holds the *model* and still applies the profile's *effort*, and native `/effort` pins only effort.

**`score` over `choice`.** The levels are ordered, and `score` tells Clef so. It also returns a probability-weighted score, which shows when Clef is torn between neighbours. `choice` is kept as a calibration option (`npm run calibrate -- --style both`) so the two can be compared on real data. Comparing them, and Clef with Clef-flash, needs Cloudflare credentials, and that benchmark has not been run for this release. See [Calibration](CALIBRATION.md).

**Clef-flash by default.** The task is a judgment about the prompt, not solving it, and Clef-flash is about 5× faster and 2.7× cheaper than Clef. Clef is one option away.

**A second question in the same pass.** "Is this a follow-up whose task is defined by earlier conversation?" (a `noul`) costs a few tokens and no latency. When it says yes, the route never drops below the turn it follows: "that didn't work" after a hard turn is still hard. Bare go-aheads (`yes, do it`) are detected without Clef and reuse the last route.

**Minimal context.** Clef sees the prompt text only (head and tail when long). It gets no history, no files, no repository facts and no previous route. Adding context would make the privacy story harder, cost tokens, and is not shown to be needed. The follow-up question covers the main case where context matters. Re-evaluate with the corpus before adding any.

**Recommendation and final route are separate objects.** `Decision.recommendation` is what Clef said. `Decision.proposed` is the profile route for Clef's level. `Decision.final` is what was sent. `Decision.adjustments` lists every rule that changed it, with a reason. All of it is shown in `/clef` and logged.

**Precedence** (first that applies wins):

1. Routing off: `enabled = false`, `+off` for one turn, `/clef off`, or a mid-session `/model` change (paused until `/clef auto`). Claude Code's own model and effort apply. A `+model` or `+profile` prompt still applies to its own turn while the session is off or paused.
2. `+target` for this turn.
3. `/clef pin` for the session.
4. Continuation (go-ahead, task notification, empty turn) → the last route.
5. Clef → profile. If Clef fails, the fallback profile, never below the last route.
6. The person's `/effort` sets the effort of a Clef, continuation or fallback route.

Then, always: unavailable models, the context window, the cache hold (for routes the router chose itself) and the effort cap and clamp.

**Cache hold.** A downgrade (to a cheaper model family) is held on the current model when:

- the cache is warm (younger than the TTL),
- the context is at least `cache_hold_min_tokens` (default 40k; Claude Code's own prompt is about 20k of that),
- and the current model is usable.

On a hold, the effort comes from the recommended profile when an effort change keeps the cache on that model, and otherwise stays as cached. The rule is a threshold rather than a price calculation. Prices change and differ by plan, and a threshold is inspectable and easy to tune. The arithmetic behind it, at Anthropic API list prices in October 2026: re-reading cached context on Opus 5.5 costs $0.20 per million tokens, while writing it fresh into Haiku 4.5's cache costs $1.25 per million (1.25 × $1). Moving a warm 100k-token conversation from Opus to Haiku therefore costs about 6× more input on that turn, before counting the trip back. Upgrades are never held: quality first.

**Failure is boring.** Every failure path ends in either "leave the request alone" or "use the fallback profile":

- Clef not configured, a timeout, a network error, an auth error, quota, rate limiting, a server error, a malformed answer.
- A model that cannot be resolved (third-party provider without pinned IDs), or that failed twice this session.
- An engine fallback mid-turn, a hook that throws, a reload mid-turn.

The guard skips Clef entirely while it is known to be failing:

| Condition | Pause |
| --- | --- |
| Three failures in a row | 5 minutes |
| Rate limited | 1 minute |
| Auth or request errors | 30 minutes |
| Quota | Until 00:00 UTC |
| Local budget reached | Until 00:00 UTC |

A dead endpoint costs one timeout, not one per prompt.

**Decision-provider boundary.** The policy consumes a `Recommendation`, which has no Cloudflare types in it. `clefProvider()` is the only code that knows Workers AI. A Jev backend (Clef is Jev-API compatible) or a local Clef server would be another `DecisionProvider`. `CLEF_ROUTER_API_BASE` already points the client at any Clef-compatible URL. There is no plugin framework.

## Prior art

| Project | Adopted | Left out, and why |
| --- | --- | --- |
| [satviksinha/jev-model-router](https://github.com/satviksinha/jev-model-router) | `turn.start` decides, `turn.step` rewrites; one decision per turn; subagents unrouted; full history in a command; "fail open looks like not loaded, so show state" | Route line written into the model's reply text (pollutes the transcript); `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` (obsolete) |
| [Flam1ngFir3ball/jev-claude-router](https://github.com/Flam1ngFir3ball/jev-claude-router) | Cache-aware holds; go-ahead and task-notification turns continue the last route; context-window guard; effort ceiling; "what actually answered" from usage; feedback on why a route was held | Dollar-priced switch model (prices drift, a threshold is inspectable); natural-language override parsing ("use opus", with negation rules: a strict `+target` prefix is predictable); compaction by the decision model (out of scope); text summaries injected into replies |
| [lucasamonrc/pi-auto-router](https://github.com/lucasamonrc/pi-auto-router) | Clef request shape and `noul` handling; tiers as a ladder; "stay on the model unless the task changed" (here: follow-up floor and cache hold); `/route test` for tuning | Task-kind taxonomy with per-kind model strengths (a multi-provider catalog problem this project does not have); wrangler OAuth token discovery (shelling out; a scoped API token in secure storage is simpler) |
| [Gjusev/clef-router](https://github.com/Gjusev/clef-router) | Escalate on low confidence; parse failures never route cheap; error taxonomy (auth / rate / server / response); calibration with committed fixtures and separate "what we measured" from "what Cloudflare measured" | OpenAI-compatible proxy, Python service, retries with backoff in the interactive path |
| [nobodyohm-web/claude-code-model-router](https://github.com/nobodyohm-web/claude-code-model-router) | Named postures/profiles users can retarget; local JSONL ledger and a stats command; honest labelling of estimates | Regex classification with hints injected for the main model to delegate; pinned subagents as the switching mechanism (a mod can rewrite the request directly) |
| Morph router | Effort as a first-class routed dimension; difficulty plus ambiguity as signals (ambiguity here is part of the rubric's "hard" level) | A local proxy in front of the Anthropic API; a multi-provider catalog |

## Technical risks

- **The mods API is early access** and changes between releases. Mitigations: everything engine-facing is in one file; `claude plugin validate` and `claude plugin test` run in CI; every hook catches its own errors, and a failing hook leaves requests untouched.
- **Clef's judgment is unmeasured for this rubric** until someone runs `npm run calibrate` with credentials. The default confidence policy leans upward, and the corpus exists for this purpose.
- **Alias table drift.** When a new model ships, the alias resolution in `models.ts` needs an update. Until then, `ANTHROPIC_DEFAULT_*_MODEL` or full IDs in `profiles` work.
- **Effort detection.** A skill's `effort` frontmatter looks like an `/effort` change for one turn. It is honoured for that turn and dropped when effort returns, rather than misread as a lasting change.
- **Per-account budget.** The local budget counts this mod's calls on this machine, not other Workers AI use on the same account.
- **Subagents that inherit the session model are not routed**, since there is no per-subagent prompt to judge and their model resolves from the session.
