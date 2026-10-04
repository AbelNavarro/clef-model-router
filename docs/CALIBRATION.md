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
  latency mean 41 ms · p50 40 ms · p95 52 ms (includes your network round trip)
  input tokens/call ~503 · ~4.1 neurons/call · ~2432 calls/day in the 10,000-neuron free allocation (estimate)
```

(These sample rows show the format only. Real numbers depend on Clef and on your network; record yours in your notes or a PR when you change the rubric.)

- `clef` is Clef's most probable level, and `conf` its confidence.
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
- Clef latency (mean, p50, p95) and mean confidence
- how often policy changed Clef's pick, cache holds, manual overrides, fallbacks by cause
- your feedback counts

For deeper analysis, the log is plain JSONL:

```sh
cat ~/.claude/plugins/data/clef-model-router/routing-*.jsonl \
  | jq -r 'select(.type=="turn" and .recommendation) | [.recommendation.level, .final.level, (.recommendation.confidence*100|floor)] | @tsv' \
  | sort | uniq -c | sort -rn
```

A good next step for a contributor is a script that joins feedback records to their turns and reports agreement by level.
