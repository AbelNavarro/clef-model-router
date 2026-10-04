# Routing, prompt caching and cost

This page explains what a per-turn model router can save, what it cannot, and why. It is what the router's downgrade policy is based on. The decision record is [ADR 0001](adr/0001-downgrade-timing-by-billing-mode.md).

Prices are Anthropic API list prices as of October 2026 ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)). Caching behaviour is from [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching). Both change; check them before relying on the numbers.

## The problem

Claude Code runs every turn of a session on one model at one effort level, whichever you last chose. That leaves three options, all poor:

- **A strong model at high effort for everything.** Debugging and design get what they need, and so do renames, typo fixes and one-line questions, which did not need it.
- **A cheaper model for everything.** Routine work is fine, and hard problems get a weaker attempt.
- **Switching by hand.** `/model` and `/effort` before every prompt. Nobody keeps that up.

The goal of this project is the **least expensive configuration that is sufficiently capable for each turn**, chosen automatically, with every decision visible and overridable. "Expensive" is not one thing. With an API key it is dollars. On a subscription it is plan usage, which runs out. Both are covered below.

## This is not a silver bullet

Be clear about what a router like this can and cannot do before relying on it:

- **Context size dominates the cost of a long session, and a router does not change it.** Every request re-sends the whole conversation, and a turn makes one request per tool result. A 200k-token conversation is read again on each of those requests, whatever model reads it. `/clear` between unrelated tasks, `/compact` at natural breaks, and keeping large outputs out of the main conversation save more than any routing.
- **Switching models is not free.** Each model has its own prompt cache, so a switch writes the whole conversation again. Often the cheapest choice is to stay on the model you are on, even if a cheaper one would do.
- **On current API prices, a warm Opus 5.5 conversation costs almost what a warm Sonnet 5.5 one does to keep going.** Their cache reads cost the same, $0.20 per million tokens. Mid-session, a model downgrade saves only on writes and output, which is not much. With an API key, the savings come mostly from effort, from the model a conversation *starts* on, and from moments when the cache is cold anyway.
- **The decision model judges the prompt, not the task.** "Fix this" can be a typo or a race condition. Clef can be wrong in both directions. The policy leans towards capability when it is unsure, so its mistakes tend to cost money rather than quality.
- **How subscriptions count usage is not published.** The subscription mode rests on an assumption, stated [below](#subscription). It may be wrong.
- **Only the main conversation is routed.** Subagents keep the model their definition or Claude Code gives them.
- **It costs something itself.** A routed prompt waits 0.3–0.5 s for Clef. It also depends on a Cloudflare account; if Clef fails, a fixed fallback route is used.
- **How well it routes real work is not yet measured.** The local log and `/clef feedback` exist to find out.

If you already choose models deliberately, keep sessions short and clear between tasks, a router may add little.

## How a session's cost is made up

| Term | What it is | Note |
| --- | --- | --- |
| Cache reads | The conversation re-read from cache, once per request | Usually the largest token count by far: context × requests |
| Cache writes | New content added to the cache; or everything, after a miss | 1.25× the input price with a 5-minute cache, 2× with a 1-hour one |
| Output | The answer, tool calls and thinking | The most expensive per token (5× input). Effort controls how much thinking there is |
| Uncached input | Small, once caching works | |

List prices, dollars per million tokens:

| Model | Input | Cache write 5 min / 1 h | Cache read | Output |
| --- | --- | --- | --- | --- |
| Fable 5.1 | 10 | 12.50 / 20 | 0.25 | 50 |
| Opus 5.5 | 4 | 5 / 8 | **0.20** | 20 |
| Sonnet 5.5 | 2 | 2.50 / 4 | **0.20** | 10 |
| Haiku 4.5 | 1 | 1.25 / 2 | 0.10 | 5 |

The caching rules that matter for routing:

- **Each model has its own cache.** Switching models means the next request reads nothing of the conversation from cache and writes all of it.
- **Effort can be changed for free on some models.** On Opus 5.5, Sonnet 5.5 and Fable 5.1, with an API key or a subscription, a different effort keeps the cache. It does not on other models, on Bedrock or Vertex, or through a gateway.
- **The cache expires after a period without use.** The default is five minutes with an API key, a cloud provider or usage credits, and one hour on a subscription within its plan's included usage. Every read resets the timer, so a model in active use stays warm indefinitely.
- **Coming back to a model often costs a full write too.** The API looks for an earlier cache entry only within 20 content blocks of the request's end. A detour of a few turns with tool calls is usually longer than that, so returning to the first model re-writes the conversation rather than reading its old entry.
- **Some moments are free.** After a compaction, a `/clear`, or an expired cache, the next request writes a new cache whatever the model. A switch then costs nothing extra.

## The switching dilemma

Suppose a session needed a strong model for a hard problem, and the next prompts are routine. Two shapes are common:

- **A dip.** One easy question in the middle of hard work, then back to it. Switching writes the conversation to the cheap model's cache, then again to the strong model's when the work resumes. Staying costs one turn on the strong model. **Staying is cheaper.**
- **A phase.** The hard part is done; the next ten turns are cleanup, docs and small questions. Staying pays the strong model's price ten times. **Switching is cheaper**, once the phase is long enough to repay the write.

At the start of a stretch, you cannot tell which one it is. A rule that compares only the current turn ("this turn is cheaper on the warm model than a full write elsewhere") says *stay* every time. Applied turn after turn, it never leaves: after the first hard turn the strong model stays for the rest of the session, until the cache expires or the conversation is cleared. Router logs show this. A one-turn rule held every single downgrade, and the session's cheaper turns never ran on the cheaper model. That was this project's first rule.

### A worked example

Take a 100k-token conversation warm on Opus 5.5. Clef judges the next prompts to be Sonnet-level. Each routine turn makes about four requests, writes about 5k new tokens and produces 1.5k output tokens.

| | API key (5-minute cache) | Subscription (1-hour cache) |
| --- | --- | --- |
| A switch to Sonnet 5.5 writes 100k | 100k × $2.50 = **$0.25** | 100k × $4 = **$0.40** (plan usage, at API-equivalent weight) |
| A held turn on Opus 5.5 | reads 400k × $0.20 = $0.08 *on either model*; writes and output cost $0.0275 more on Opus | $0.08 reads + $0.04 writes + $0.03 output = **$0.15**, all of it from Opus's allowance |
| Staying has cost as much as switching after | about **10** routine turns | about **3** routine turns |

With an API key, the downgrade rarely pays. Reads, which are most of the cost, are priced the same, and a later return to Opus costs another 100k × $5 write. On a subscription the comparison is different, because of what is scarce.

## By billing mode

### API key, cloud provider or gateway

You pay per token, so the right measure is dollars. The extra cost of staying is the price difference for the same tokens. Between Opus 5.5 and Sonnet 5.5 that is small: writes and output only. A held downgrade is therefore taken only after a long stretch, and is correct to be.

What the router still saves: lower effort on every routine turn (free on 5.5 models, and it cuts thinking, which is billed as output); the cheaper model when the conversation starts or the cache has expired; and turns whose output is large.

Cloud providers price differently from Anthropic (regional endpoints cost 10% more), and effort changes break the cache there. A gateway that strips cache markers caches nothing, so there is no cache to keep. The router sees that in the API's usage reports and holds nothing.

### Subscription

You pay a flat fee, so what runs out is plan usage. Plans meter usage over a 5-hour window and a weekly window. Max plans also meter the heavier models separately, and Claude Code shows a model-specific limit message ("You've hit your Opus limit"). Anthropic does not publish how tokens are weighted in these meters. It says cached content "counts less", which suggests they track API prices. **The router assumes they are proportional to API list prices. That assumption is unverified.**

Under it, a held turn on Opus is drawn entirely from Opus's allowance, which Sonnet-level work did not need, and which is usually the first to run out. A switch is a one-time write on the general allowance. So on a subscription, the whole cost of a held turn counts as "spent", and the router moves after a short stretch.

The 1-hour TTL on subscriptions makes this matter more. A strong model stays warm through an hour of pauses, so a rule that holds while the cache is warm holds for as long as you keep working.

Past the plan's included usage, requests draw usage credits, billed per token like the API, and the cache drops to five minutes. The router detects that (a rate-limit window at 100% or more) and switches to the API rules.

## What the router does

1. **It weighs a downgrade over the stretch, not the turn.** When Clef's pick would leave a warm model for a cheaper one, the turn stays on the warm model while what staying has cost so far, over the held turns of this stretch, is less than what the switch costs now. Once it reaches that, the downgrade is taken. This is the classic answer to renting versus buying when you don't know how long you will need something. Short dips stay put, long phases move. Whatever the session's shape, it never pays more than about twice what the best choice in hindsight would have. `downgrade_patience` scales the threshold, and `0` takes every downgrade at once.
2. **What counts as spent depends on billing.** With an API key, it is the dollar difference between the two models for the held turn's tokens. On a subscription, it is the whole held turn. `billing` is detected, or can be set.
3. **Effort still comes down on a held turn.** On models where an effort change keeps the cache, a held turn runs at the effort Clef's level asked for. A trivial prompt held on Opus runs at `low`, not at the effort of the hard turn before it.
4. **It switches for free when it can.** It takes the downgrade at once after a compaction, a `/clear` or an expired cache, and when nothing is being cached.
5. **Upgrades are never held.** When Clef asks for more capability, the turn gets it at once.
6. **It says what it is doing.** The route line shows `(Sonnet deferred)` while a downgrade is held. `/clef` shows the billing mode and how it was detected, what staying has cost so far and what the switch costs. The log records every deferral.

### Why not lower effort instead of switching model?

Effort is the one lever that is free mid-session on current models, and the router uses it on every held turn. But it is not a substitute for the model:

- Effort controls thinking and output. It does not reduce the context reads, which are most of the tokens in a long session.
- A strong model at low effort and a cheaper model at medium effort are different things. Neither is known to match the other's quality. The router does not push effort below what Clef's level asks for to make up for holding a stronger model.
- Where an effort change breaks the cache (older models, Bedrock, Vertex, gateways), it costs a full rewrite like a model switch. The router weighs it the same way.

## What is still unknown, and how to find out

The router's log, `~/.claude/plugins/data/clef-model-router/`, records what is needed to check these assumptions:

| Question | Log fields |
| --- | --- |
| How do subscription windows move under each policy? | `rateLimits` (each window's percentage at the start of each turn), `billing`, `final.model` |
| How much does a switch, or a return, really cost? | `firstStep.cacheReadTokens` and `cacheWriteTokens` on the turn after a model change |
| Are sessions mostly dips or phases? | `deferral` on consecutive turns: how long held stretches last, and how they end |
| Were held turns over-powered, or switched turns under-powered? | `/clef feedback` records joined to turns with a `deferral` |

```sh
# Held stretches: turns held, and how each one ended
cat ~/.claude/plugins/data/clef-model-router/routing-*.jsonl \
  | jq -r 'select(.type=="turn" and .deferral) | [.session[0:8], .deferral.turns, .deferral.held, .deferral.billing, (.deferral.spent*100|floor), (.deferral.cost*100|floor)] | @tsv'
```

If the subscription assumption turns out wrong, the fix is in one place: how `stayCost` in [`hooks/lib/pricing.ts`](../hooks/lib/pricing.ts) counts a held turn.
