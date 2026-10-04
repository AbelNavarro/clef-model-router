# ADR 0001: Time downgrades off a warm cache by what staying costs, per billing mode

- **Status:** Accepted
- **Date:** 2026-10-04
- **Supersedes:** the threshold cache hold of v0.1.0–0.1.4 (`cache_hold_min_tokens`)

## Context

The router exists to run each turn on the least expensive configuration that is capable enough. Each model has its own prompt cache, so moving a warm conversation to a cheaper model writes all of it again. To avoid paying for that, v0.1 held every downgrade on the current model while the cache was warm and held at least 40k tokens.

In practice that rule held every downgrade in a session:

- Claude Code's own prompt is most of 40k, so the threshold was met from the first turn.
- A held turn ran on the strong model, which kept its cache warm, so the next downgrade was held too. Only `/clear` or an idle gap longer than the TTL ended it. The TTL is one hour on a subscription.
- Upgrades were never held, and the confidence and follow-up rules only move up. After the first hard turn, the router could only stay or go up.
- A held trivial turn kept the cached effort (`xhigh` after a deep turn), because the Haiku profile has no effort to apply.

The rule compared one turn at a time. Each comparison was locally right, since one turn on the warm model is cheaper than a full write. Over a long routine stretch the total was wrong. The rule also priced everything in API dollars, while many users pay by subscription. There the scarce resource is plan usage, and Max plans meter the heavier models separately.

At October 2026 list prices, cache reads on Opus 5.5 and Sonnet 5.5 cost the same ($0.20/MTok). With an API key, staying on a warm Opus 5.5 is often genuinely cheaper than downgrading. On a subscription, every held turn spends the stronger model's allowance on work that did not need it.

The full analysis is in [Routing, prompt caching and cost](../COSTS.md).

## Decision

1. **Weigh a downgrade over the stretch.** When Clef's route would leave a warm cache for a cheaper model, hold the turn on the warm model while the cost of staying, summed over the held turns so far, is less than the switch cost now (`context × the new model's cache-write price`) times `downgrade_patience` (default 1, and 0 takes every downgrade at once). Then take the downgrade. This is the deterministic ski-rental rule. It is at most about twice the best choice in hindsight, and needs no prediction of how long a stretch will last.
2. **Count the cost of staying in the unit the billing makes scarce.**
   - `api`: the dollar difference between the held and wanted models for the held turn's tokens.
   - `subscription`: the whole held turn, which is drawn from the stronger model's allowance.
3. **Detect billing, and let it be set.** The `billing` option is `auto` (the default), `subscription` or `api`. Auto-detection uses, in order:
   - the plan's rate-limit windows (`$.session.usage().rateLimits`), which are reported only on a subscription; a window at 100% or more means usage credits, which count as `api`;
   - a gateway `spend_limit`;
   - the environment: a cloud provider, `ANTHROPIC_API_KEY` or `apiKeyHelper`, or `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` mean `api`, and nothing set means `subscription`.

   The cache TTL follows the detected billing, not the configured one.
4. **Lower effort on held turns.** On models where an effort change keeps the cache, a held turn runs at the effort Clef's level asked for. A level whose model takes no effort (Haiku) gets the held model's lowest effort.
5. **Take free switches.** After a compaction, a `/clear` or an expired cache, and when the API reports no caching, the downgrade is taken at once.
6. **Keep upgrades immediate.** Quality comes first.
7. **Explain it.** The route line shows `(<Model> deferred)`. `/clef` shows the billing, how it was detected, and the spent and switch figures. The log records `billing`, `deferral`, `firstStep` and `rateLimits`.

Where an effort change breaks the cache, the same rule weighs a lower effort, with the switch cost being a rewrite on the same model.

## Alternatives considered

- **Keep the threshold hold.** Rejected: it makes the strongest model sticky, which defeats the project's purpose.
- **Remove cache awareness.** Rejected: with API billing on current prices, it would often cost more. Short dips would pay two full writes (out, then back) for one cheap turn.
- **A one-turn dollar comparison including the return trip** (as in jev-claude-router). This is better priced, but it has the same one-turn horizon, so it never releases a long stretch.
- **Hysteresis of N turns.** Simple, but blind to context size. A fixed N is too eager at 500k tokens and too slow at 40k.
- **Lower effort below the profile's on a held turn**, to make up for the stronger model. Rejected for now: no measurement says what effort on one model matches another model's capability.
- **Use a new-task signal** (Clef's follow-up probability) to switch sooner. Deferred: it is not needed for the rule, and it is unmeasured.

## Consequences

- With an API key, an Opus 5.5 → Sonnet 5.5 downgrade is taken only after long stretches. That is correct in dollars, and the router's savings there come from effort and from cold-cache moments. Opus → Haiku and Fable → Opus downgrades are taken sooner, because reads or output differ more.
- On a subscription, a downgrade is taken after a few routine turns. Some single-turn dips still stay on the strong model.
- The first downgrade off a warm cache is always held for one turn, even at small contexts. This is cheap, but visible.
- Prices are hard-coded list prices (`hooks/lib/pricing.ts`) and need updating when they change. Only ratios matter, so regional or negotiated pricing does not change decisions much.
- `cache_hold_min_tokens` is replaced. `0` still turns holding off, and is reported. Other values are ignored, and also reported.

## Revisit when

- Dogfooding logs show how subscription windows (`rateLimits`) move under this policy. If plan usage does not track API prices, change what `stayCost` counts.
- `firstStep` shows whether returns to a model really pay a full rewrite.
- Prices change so that cache reads differ between Opus and Sonnet, or effort changes start keeping the cache on more models or providers.
