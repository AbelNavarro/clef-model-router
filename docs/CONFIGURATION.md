# Configuration

There are two places to configure the mod. Neither involves editing its source.

1. **Plugin options**: the everyday settings. Set them with `/plugin configure clef-model-router@clef-model-router`, or change them one by one in `/config`. A change in `/config` reloads the mod with the new value.
2. **Advanced file** (optional): tuning knobs in `~/.claude/clef-model-router.json`, or wherever `CLEF_ROUTER_CONFIG` points. It is read when the mod loads. After editing it, run `/reload-plugins` or start a new session.

An invalid value never stops the mod. It falls back to the default, and `/clef` lists the problem under `config!`.

## Plugin options

| Option | Default | |
| --- | --- | --- |
| `cloudflare_account_id` | (none) | Your Cloudflare account ID. Falls back to `$CLOUDFLARE_ACCOUNT_ID`. |
| `cloudflare_api_token` | (none) | A Workers AI API token. **Sensitive**: masked on entry, stored in your system's secure credential store, never in `settings.json`. Falls back to `$CLOUDFLARE_API_TOKEN`. |
| `decision_model` | `clef-flash` | `clef-flash` ($0.09 per million input tokens; ~40 ms model time, ~0.3–0.5 s end to end) or `clef` ($0.24 per million; ~210 ms model time). |
| `profiles` | `haiku, sonnet:low, sonnet:medium, opus:high, opus:xhigh` | What each difficulty level runs on, lowest first: trivial, simple, standard, hard, deep. Each entry is `model[:effort]`, where model is an alias (`haiku`, `sonnet`, `opus`, `fable`) or a full model ID. With no effort, the turn keeps the effort Claude Code would send (Haiku takes none). |
| `announce` | `status` | `status`: dimmed at the end of the hint line under the prompt (terminal only). `answer`: a line under each answer. `both`, or `off`. |
| `enabled` | `true` | Off: the mod stays loaded but leaves every request alone. |
| `log_prompts` | `false` | Write each prompt's text into the local log. Off: only a hash and the length. |

Example profiles:

```
haiku, haiku, sonnet:medium, opus:high, fable:high        # cheaper low end, Fable for the hardest work
sonnet:low, sonnet:low, sonnet:medium, sonnet:high, opus:high   # never Haiku
claude-haiku-4-5, claude-sonnet-5-5:low, claude-sonnet-5-5:medium, claude-opus-5-5:high, claude-opus-5-5:xhigh   # pinned IDs
```

Fable models may bill to usage credits depending on your plan. Claude Code asks before it does that.

## Advanced file

A JSON object; every key is optional.

```json
{
  "confidence_threshold": 0.55,
  "low_confidence_policy": "upper-of-top-two",
  "fallback_profile": "standard",
  "follow_up_threshold": 0.6,
  "cache_hold_min_tokens": 40000,
  "cache_ttl_minutes": 0,
  "max_effort": "none",
  "timeout_ms": 1500,
  "daily_neuron_budget": 9000,
  "max_prompt_chars": 6000,
  "pause_on_native_change": true,
  "log_enabled": true,
  "log_dir": "/path/to/logs",
  "rubric_file": "/path/to/rubric.json"
}
```

| Key | Default | |
| --- | --- | --- |
| `confidence_threshold` | `0.55` | When Clef gives its pick less than this probability (0..1), `low_confidence_policy` applies. This is the probability of the chosen level, not Clef's own `confidence` field, which is logged separately. |
| `low_confidence_policy` | `upper-of-top-two` | `upper-of-top-two`: the more capable of Clef's two likeliest levels. `bump`: one level up. `hold`: the last turn's level, or the fallback. `fallback`: `fallback_profile`. `obey`: Clef's pick anyway. |
| `fallback_profile` | `standard` | Used when Clef cannot answer, never below the previous turn's level. |
| `follow_up_threshold` | `0.6` | When Clef rates a prompt a follow-up at least this likely, the route never drops below the turn it follows. |
| `cache_hold_min_tokens` | `40000` | On a downgrade, keep the current model when at least this many tokens are cached and the cache is warm. `0` never holds. |
| `cache_ttl_minutes` | `0` | Prompt-cache lifetime used to judge "warm". `0` resolves it as Claude Code does: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`, then 60 minutes on a subscription or 5 with an API key or cloud provider. |
| `max_effort` | `none` | Never route above this effort (`low` … `max`). |
| `timeout_ms` | `1500` | How long to wait for Clef before using the fallback. |
| `daily_neuron_budget` | `9000` | Stop calling Clef once this many neurons (estimated) are used today, UTC. Workers AI's free allocation is 10,000. `0` means no local limit. |
| `max_prompt_chars` | `6000` | Prompts longer than this are cut to head (75%) and tail (25%) before they are sent. |
| `pause_on_native_change` | `true` | A mid-session `/model` change pauses routing; an `/effort` change sets effort while Clef keeps picking the model. `false`: the router ignores both. |
| `log_enabled` | `true` | The local routing log. |
| `log_dir` | `~/.claude/plugins/data/clef-model-router` | Where the log goes (inside `$CLAUDE_CONFIG_DIR` when that is set). |
| `rubric_file` | (none) | A JSON rubric replacing the built-in one; see [Calibration](CALIBRATION.md#changing-the-rubric). |
| `profile_trivial` … `profile_deep` | (none) | Set one profile. This wins over the `profiles` list. |

The advanced file cannot set the API token. A token found there is ignored and reported, because a plain JSON file is not a safe place for it.

## Precedence

From strongest to weakest:

1. **Routing off.** Any of these leaves Claude Code's own model and effort untouched:
   - `enabled = false` (the mod is inert)
   - `+off …` (this turn)
   - `/clef off` (this session), or a mid-session `/model` change (paused until `/clef auto`). A `+model` or `+profile` prompt still applies to its own turn while the session is off or paused.
2. **`+target …`**: this turn only. The target is a profile (`+hard`), an alias or ID with optional effort (`+opus:max`, `+claude-sonnet-5-5:low`), or only an effort (`+:high`, where Clef still picks the model).
3. **`/clef pin <target>`**: the rest of the session, until `/clef auto`.
4. **Continuation**: a go-ahead, a task notification or an empty turn reuses the last route.
5. **Clef's recommendation**, through the confidence policy and the follow-up floor. When Clef fails: the fallback.
6. **Your `/effort`**: sets the effort of a Clef, continuation or fallback route, not of an explicit `+target` or pin. It lifts automatically when Claude Code's effort returns to what it was. `/clef auto` also clears it.

These always apply last, to every route:

- a model that is unavailable or failed this session is skipped, moving upward first;
- a context too big for the model's window moves to a profile that fits;
- a cache hold, for routes the router chose itself only;
- the `max_effort` cap, and clamping effort to what the model supports.

Subagents are never routed; they keep their own model.

Choices made at launch (`claude --model opus`, `--effort high`) are the baseline the router starts from, not overrides. To make one stick, use `/clef pin` or `/clef off`.

## Environment variables

| Variable | |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Credential fallbacks when the plugin options are empty. A variable is inherited by every command Claude runs, so prefer the plugin option for the token. |
| `CLEF_ROUTER_CONFIG` | Path of the advanced file. |
| `CLEF_ROUTER_API_BASE` | Base URL instead of `https://api.cloudflare.com/client/v4`, for a proxy or a Clef-compatible endpoint. The path `/accounts/{id}/ai/run/@cf/cloudflare/{model}` is appended. Your token is sent to this URL, so set it only to a host you trust. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` … `_FABLE_MODEL` | Claude Code's own alias pins, honoured when resolving profile aliases. |
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` | On these providers, unpinned aliases do not resolve. Use full model IDs in `profiles`, or set the `ANTHROPIC_DEFAULT_*_MODEL` variables. |

## Third-party providers

On Bedrock, Vertex or Foundry, model IDs differ from the Anthropic API's. Give `profiles` your provider's IDs, for example `us.anthropic.claude-sonnet-4-5-20250929-v1:0`; a trailing `:0` is understood as part of the ID. Alternatively, set `ANTHROPIC_DEFAULT_*_MODEL`. A profile that cannot be resolved is skipped. If none can be, the mod leaves requests alone, and `/clef profiles` shows what resolved.
