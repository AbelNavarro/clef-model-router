# Calibration

The router is only as good as the question Clef is asked. This page covers how to see what Clef does with your prompts, how to change the question, and how to tell whether routing works for you.

## The rubric

[`hooks/lib/rubric.ts`](../hooks/lib/rubric.ts) holds everything Clef is told.

- **`instructions`**: what to rate ("how much model capability and reasoning effort the agent needs…, judge the work, not the length").
- **`levels`**: five descriptions, lowest first: trivial, simple, moderate, hard, very hard. Clef receives them as a `score` question, an ordered rubric, and returns a probability for each level.
- **`followUp`**: a yes/no question asking whether the message is a follow-up whose task is defined by earlier conversation.

Clef answers both questions in one forward pass.

Levels map to profiles in configuration, not in the rubric. To change *what runs* for hard prompts, edit `profiles`. To change *which prompts count as hard*, edit the rubric.

## Running the corpus

[`corpus/prompts.jsonl`](../corpus/prompts.jsonl) has 48 labelled prompts across the spectrum. Some are hard on purpose:

- short but hard: "race in the scheduler again. look at it"
- a long paste with a trivial ask
- follow-ups that need context

```sh
export CLOUDFLARE_ACCOUNT_ID=...      # environment only; never on the command line
export CLOUDFLARE_API_TOKEN=...
npm run calibrate                             # clef-flash, score question
npm run calibrate -- --model both --style both    # clef vs clef-flash, score vs choice
npm run calibrate -- --rubric my-rubric.json      # try a rubric without touching the mod
npm run calibrate -- --corpus my-prompts.jsonl    # your own prompts
npm run calibrate -- --json > results.json        # every probability, for analysis
npm run calibrate -- --min-within 0.9             # exit 1 below 90% within one level (a regression gate)
npm run calibrate -- --mock                       # no network: fake answers, to see the output
```

Output, one row per prompt:

```
    ms  clef      conf  dist(t s m h d)  route     label       prompt
    42  trivial   .94  ▇▁▁▁▁           trivial   trivial ✓  Fix the spelling of "recieve" in README.md.
    39  standard  .73  ▁▂▆▁▁           standard  standard✓  Add pagination to the /orders endpoint ...
    44  hard      .81  ▁▁▁▇▁           hard      hard    ✓  Debug why these tests intermittently deadlock ...
    41  deep      .88  ▁▁▁▁▇           deep      deep    ✓  Study this subsystem, determine why ...

  labelled 48: exact 41 (85%) · within one level 47 (98%) · under-routed 3 · over-routed 4 · failures 0
  latency mean 420 ms · p50 410 ms · p95 530 ms (includes your network round trip)
  input tokens/call ~503 · ~4.1 neurons/call · ~2432 calls/day in the 10,000-neuron free allocation (estimate)
```

(These sample rows show the format only. Real numbers depend on Clef and on your network; record yours in your notes or a PR when you change the rubric.)

- `clef` is Clef's most probable level, and `conf` the probability Clef gave it.
- `dist` shows the probabilities for trivial, simple, moderate, hard and deep.
- `route` is the level after the default confidence policy.
- `↓` marks a route below the label (too weak; the costly mistake) and `↑` a route above it (only cost).

The corpus labels are one person's judgment. "Within one level" is a fairer measure than "exact".

### What to compare

- **`score` vs `choice`.** `score` tells Clef the levels are ordered. `choice` treats them as unrelated options. Prefer the one with fewer `↓`.
- **Clef vs Clef-flash.** Clef is about 5× slower and 2.7× more expensive. Switch to it only if it is clearly better on your prompts.
- **Confidence policy.** Look at the rows where `clef` and `route` differ. If `upper-of-top-two` moves up too often, lower `confidence_threshold`.

This release ships the tooling and the corpus. The comparisons above have not been run yet, because they need Cloudflare credentials. Results are welcome as a pull request.

## Changing the rubric

Either edit `DEFAULT_RUBRIC` in `rubric.ts`, or put a JSON file anywhere and point `rubric_file` (in the advanced file) at it:

```json
{
  "instructions": "A developer sent this message to Claude Code ... Rate how much capability ...",
  "levels": [
    "Trivial: ...",
    "Simple: ...",
    "Moderate: ...",
    "Hard: ...",
    "Very hard: ..."
  ],
  "followUp": "Is this message a short follow-up ... ?"
}
```

There must be exactly five levels, lowest first. `followUp` is optional; an empty string turns the question off. Test the file with `npm run calibrate -- --rubric file.json` before using it. A file that fails validation is ignored, and `/clef` shows why.

Tips from earlier routers and from Clef's design:

- Describe the **work** at each level with concrete examples. Clef matches against these descriptions.
- Say explicitly that length is not difficulty.
- Keep the levels mutually exclusive, and the total short. Every rubric token is billed on every call.

## Was Clef right?

Two signals accumulate in your local log as you work:

1. **Your corrections.** Each time you override with `+target`, `/clef pin`, `/model` or `/effort`, the source is recorded. A turn you re-ran with `+opus` after a Sonnet answer is a strong "under" signal.
2. **Your feedback.** `/clef feedback under` (needed more), `ok`, or `over` (was more than needed), with an optional note. It is attached to the last turn.

`/clef stats 30` summarizes the last 30 days:

- turns by model, effort, profile and source
- Clef latency (mean, p50, p95) and the mean probability of Clef's pick
- how often policy changed Clef's pick, turns held on a warm model and downgrades taken after a hold, manual overrides, fallbacks by cause
- your feedback counts

## The log format

There is one file per UTC day and session: `~/.claude/plugins/data/clef-model-router/routing-<YYYY-MM-DD>-<session>.jsonl`. Each line is one JSON object, either a turn record or a feedback record, and every record has `"v": 1`. Fields are only added, never renamed; a breaking change would bump `v`.

### Turn records (`"type": "turn"`), written when a turn ends

| Field | Meaning |
| --- | --- |
| `ts`, `session`, `turn` | When the turn ended, the Claude Code session ID, and the turn ID |
| `kind` | `prompt`, `go-ahead`, `notification` (a background task woke the session) or `empty` |
| `source` | Where the route came from: `clef`, `fallback` (Clef failed), `override` (`+target`), `pin` (`/clef pin`), `continuation` (reused the last route), `native` (paused after `/model`), or `disabled` |
| `promptHash`, `promptChars` | First 16 hex characters of the prompt's SHA-256, and its length |
| `prompt` | The prompt text: **only with `log_prompts` on** |
| `provider` | `clef-flash` or `clef`, when Clef answered |
| `recommendation.level` | Clef's most probable level: `trivial`, `simple`, `standard`, `hard` or `deep` |
| `recommendation.confidence` | The probability of that level: what `confidence_threshold` compares |
| `recommendation.clefConfidence` | Clef's own `confidence` field (entropy-like, lower than the probability) |
| `recommendation.probabilities` | The probability of each of the five levels |
| `recommendation.score` | Clef's probability-weighted level, 0–4 |
| `recommendation.followUp` | Probability that the prompt is a follow-up defined by earlier turns |
| `latencyMs`, `clefInputTokens` | Clef round trip as measured by the mod; tokens Cloudflare billed |
| `proposed` | The route Clef's level maps to, before policy: `{ level, model, effort }` |
| `final` | The route sent: `{ level?, model, effort? }`. Absent: Claude Code's own model and effort were left alone |
| `adjustments[]` | Every policy change, in order: `{ rule, from, to, reason }`. The rule is `low-confidence`, `context-dependent`, `unavailable`, `context-window`, `cache-hold`, `pinned-effort`, `effort-cap` or `effort-clamp` |
| `failure` | When Clef did not answer: `{ kind, message, status? }`. The kind is `timeout`, `network`, `auth`, `quota`, `budget`, `rate-limited`, `server`, `bad-request`, `malformed`, `not-configured` or `circuit-open` |
| `note` | A human-readable reason for a fallback, continuation or unrouted turn |
| `answered` | What the Claude API reported, summed over the turn's main-loop requests: `{ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` |
| `firstStep` | Cache read and write of the turn's first request: `{ cacheReadTokens, cacheWriteTokens }`. After a model change, this is what the switch (or the return) cost |
| `billing` | `subscription` or `api`, as the policy saw it (detected, or set with `billing`) |
| `deferral` | A downgrade weighed against a warm cache: `{ wanted, from, billing, spent, cost, turns, held }`. `held: true` stayed on `from`; `held: false` took the downgrade after `turns` held turns. `spent` and `cost` are list-price dollars. See [Routing, prompt caching and cost](COSTS.md) |
| `rateLimits` | The plan's rate-limit windows at the start of the turn, `[{ kind, percentUsed }]`. Subscriptions only |
| `steps`, `durationMs`, `endReason` | Model requests in the turn, wall time, and `answer`, `aborted`, `refusal` or `error` |

### Feedback records (`"type": "feedback"`), written by `/clef feedback`

| Field | Meaning |
| --- | --- |
| `ts`, `session` | When, and in which session |
| `turn` | The turn the verdict is about: the last turn before the command |
| `verdict` | `under` (needed more capability), `ok`, or `over` (more than needed) |
| `note` | Optional free text after the verdict |

### Questions the log answers

- **Was Clef right?** Join each feedback record to the turn with the same `turn` ID, and compare `verdict` with `recommendation.level` and `final.level`.
- **Did I override it?** Within a session, records are in time order. A `source: "override"` turn straight after a `clef` turn is a manual correction of that turn.
- **Is 55% the right threshold?** `recommendation.probabilities` is complete, so the policy can be replayed offline at any threshold and compared with your verdicts.
- **What did policy change, and why?** `proposed` vs `final`, plus `adjustments`.
- **Did a route cost cache?** `answered.cacheReadTokens` vs `cacheWriteTokens`, and `firstStep` for the turn's first request.
- **Did holding a downgrade pay?** Follow `deferral` across a session's turns: how long stretches last, how they end, and whether the plan's `rateLimits` move faster or slower than under `downgrade_patience: 0`.

For classifying *which kinds* of tasks Clef gets wrong, the prompt text matters. Turn on `log_prompts` while you collect calibration data. The log never leaves your machine.

```sh
# Clef's level vs the route taken vs the probability, most common first
cat ~/.claude/plugins/data/clef-model-router/routing-*.jsonl \
  | jq -r 'select(.type=="turn" and .recommendation) | [.recommendation.level, .final.level, (.recommendation.confidence*100|floor)] | @tsv' \
  | sort | uniq -c | sort -rn

# Each verdict next to the turn it judges
cat ~/.claude/plugins/data/clef-model-router/routing-*.jsonl | jq -s -r '
  (map(select(.type=="turn")) | INDEX(.turn)) as $t
  | .[] | select(.type=="feedback") | $t[.turn] as $r
  | [.verdict, $r.recommendation.level // "-", $r.final.level // $r.final.model // "-", ($r.recommendation.confidence // 0 | .*100 | floor), ($r.prompt // $r.promptHash)] | @tsv'
```
