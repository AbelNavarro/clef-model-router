# Troubleshooting

Start with `/clef`: it shows the mode, configuration problems, the last decision and why, today's Clef usage, and whether calls are paused.

## Nothing happens: no `↳ Clef` line, no `/clef`

- **Claude Code too old.** Mods need 2.1.287 or later. Check with `claude --version`, then `claude update`.
- **The mod did not load.** Run `/plugin`; the line under the tabs names the active mods (`1 mod active · clef-model-router`). If it is missing:
  - check `claude plugin list`;
  - run `/reload-plugins`;
  - start with `claude --debug` and look for lines starting `clef-model-router:`.
- **Mods are turned off** by `disableAllHooks`, `--safe-mode`, or an organization's `allowManagedModsOnly`. See [Turn mods on or off](https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off).
- **The route line is drawn only in the terminal** (at the end of the hint line under the prompt). In the Desktop app, the VS Code chat panel and `claude -p`, use `/clef`, or set `announce` to `answer`.

## `Clef: not configured`

The account ID or token is empty. Run `/plugin configure clef-model-router@clef-model-router`. Until then, every turn runs on the fallback profile (`standard`: Sonnet · medium). The fallback does not depend on Clef.

## `Clef ✕ <reason> → …`

Clef did not answer, and the turn used the fallback. `/clef` shows the full message.

| Reason | Meaning | What to do |
| --- | --- | --- |
| `auth` | Cloudflare rejected the token (HTTP 401/403, code 10000). Calls pause for 30 minutes. | Create a new Workers AI token and set it again. |
| `bad-request` | The request was refused, often a wrong account ID (HTTP 4xx). Calls pause for 30 minutes. | Check the account ID. |
| `quota` | Workers AI's free daily allocation is used up (code 3036). | Nothing; it resets at 00:00 UTC. On the Workers Free plan you are not billed. |
| `budget` | The mod's own daily budget (`daily_neuron_budget`) is reached. | Raise it in the advanced file if you are on Workers Paid and accept the cost. |
| `timeout` | No answer within `timeout_ms` (1.5 s). | Usually a slow network. Raise `timeout_ms` if it happens often. |
| `rate-limited` | HTTP 429 without quota (capacity, code 3040). Calls pause for a minute. | Nothing. |
| `server`, `network` | Cloudflare or your connection failed. | Nothing. Three in a row pause calls for 5 minutes (`circuit-open`). |
| `malformed` | The response did not match Clef's published schema. | Report it, with the message from `/clef`. |

Check the endpoint outside Claude Code with `npm run smoke` (credentials in the environment).

## The route looks wrong

- `/clef` shows Clef's full distribution and every policy change. A route marked `(unsure)` came from the confidence policy, `(Sonnet deferred)` from a downgrade held off a warm cache, `(follow-up)` from the follow-up floor.
- **One turn:** start the next prompt with `+opus:high`, or another target.
- **Persistently:** add those prompts to a corpus and run `npm run calibrate`. Then adjust the rubric or `profiles`; see [Calibration](CALIBRATION.md).
- Report it with `/clef feedback under` or `over`, so `/clef stats` can show the trend.

## It keeps a model I expected it to leave

That is a deferred downgrade, shown as `(Sonnet deferred)`. Moving a warm conversation to another model writes it all again, so the router stays until staying has cost what the switch costs, then moves. With an API key this can take many turns: Opus 5.5 and Sonnet 5.5 cost the same to re-read. `/clef` shows the billing mode, what staying has cost so far, and what the switch costs. To change it, set `billing`, or `downgrade_patience` (`0` takes every downgrade at once), or start fresh with `/clear`. See [Routing, prompt caching and cost](COSTS.md).

## `Clef paused (you chose /model)`

You changed the model with `/model` mid-session, so the router stepped back. `/clef auto` resumes. To make the router ignore `/model` and `/effort`, set `pause_on_native_change: false`.

## A model keeps failing

When a routed request gets no response, the rest of that turn runs on Claude Code's own model. After two failures, the model is not routed to again in the session (`/clef` lists it under `unusable`). Typical causes:

- your organization's `availableModels` or `deniedModels`;
- a third-party provider with first-party IDs (see [Third-party providers](CONFIGURATION.md#third-party-providers));
- an alias Claude Code resolves differently from this mod's table. Pin full IDs in `profiles`.

## Fable asks about usage credits

Claude Code asks before a Fable request bills usage credits on some plans. If a profile uses `fable`, routing to it raises that prompt. Keep Fable out of `profiles` to avoid it.

## Logs

The log is in `~/.claude/plugins/data/clef-model-router/` by default, or under `$CLAUDE_CONFIG_DIR` when that is set. `/clef` prints the path. If no file appears, check the directory is writable and `log_enabled` is not false. Writing the log never fails a turn.
