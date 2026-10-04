# Privacy and security

## What is sent to Cloudflare

For each turn where Clef is asked, there is **one HTTPS request** to `api.cloudflare.com` (or `CLEF_ROUTER_API_BASE`):

```
POST /client/v4/accounts/<your account ID>/ai/run/@cf/cloudflare/clef-flash
Authorization: Bearer <your token>

{
  "model": "clef-flash",
  "state": "<the prompt you typed>",
  "questions": { "difficulty": { ...the fixed rubric... }, "follow_up": { ...fixed... } }
}
```

- **Text:** the prompt as Claude Code will send it to Claude, with pasted text expanded. A prompt longer than 6,000 characters (`max_prompt_chars`) is cut to its first 75% and last 25% of that length, with a note of how much was omitted. A leading `+target` prefix is removed before anything is sent.
- **Metadata:** none. The questions are the same fixed text on every call; see [`hooks/lib/rubric.ts`](../hooks/lib/rubric.ts).
- **Never sent:**
  - conversation history and Claude's answers
  - file contents and tool calls or results
  - images and attachments
  - the repository name, path or git state
  - your model, plan, or previous routes
  - anything about your machine

Cloudflare also sees what any HTTPS API sees: your IP address, request time and size.

**No request is made** for:

- go-aheads (`yes`, `do it`, `continue`)
- background-task notifications and empty turns
- `+model` and `+profile` prompts
- sessions pinned to a model or profile
- `/clef off`, or `enabled = false`
- an unconfigured mod
- a day past the local budget or Cloudflare's free allocation
- the few minutes after repeated failures

`/clef test <prompt>` sends that prompt.

## What Cloudflare says it does with it

As of October 2026:

- **Workers AI** ([Data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/), last updated April 21, 2026): "Cloudflare does not use your Customer Content to (1) train any AI models made available on Workers AI or (2) improve any Cloudflare or third-party services, and would not do so unless we received your explicit consent." Inputs and outputs are Customer Content, which you own, and they are not shared with other customers. They are stored only if you use a storage service such as R2 or KV alongside Workers AI; this mod does not.
- **Clef** ([announcement](https://blog.cloudflare.com/clef-decision-models/)): Cloudflare says it does not read, store or train on Clef requests or responses, unless you use its fine-tuning service. This mod does not.

Processing is also governed by Cloudflare's [Privacy Policy](https://www.cloudflare.com/privacypolicy/) and your subscription agreement. Check those pages for the current wording; this summary is not legal advice.

## What stays on your machine

| What | Where | Contains prompt text? |
| --- | --- | --- |
| Routing log, one JSON line per turn | `~/.claude/plugins/data/clef-model-router/routing-<date>-<session>.jsonl` (`log_dir` to change) | **No** by default: a 16-hex-character SHA-256 prefix and the length. With `log_prompts` on: yes, in full. |
| Session state: mode, pin, last route, history of the last 50 turns | Claude Code's session state for the mod (`$.state`), kept for the session | First 200 characters of each prompt, for `/clef history`. Not written to the log. |
| Daily counters: calls, Clef tokens, pause state | The mod's store under Claude Code's config directory (`$.store`) | No |
| Options | `settings.json` → `pluginConfigs` | No. The token is not here (see below). |

Each log line has the turn's route, Clef's recommendation and probabilities, latency, policy adjustments, failure kind and the token usage the Claude API reported. To stop logging, set `log_enabled: false` in the advanced file. To delete the log, remove the directory. Nothing is ever sent to a third party: there is no telemetry.

## Credentials

- **The API token** is a `sensitive` plugin option. Claude Code masks it on entry and keeps it in the platform's secure credential store (the macOS Keychain, or its equivalents elsewhere), not in `settings.json`. The mod reads it only to set the `Authorization` header of the Clef request.
- It never appears in a URL, a request body, a command line, the log, `/clef` output or an error message. `/clef` shows only `token set` or `token not set`. Error text returned by Cloudflare passes through a redactor: bearer tokens, `key=value` secrets, the token and account ID themselves, and any long opaque string are replaced with `[redacted]`.
- **Environment variables** (`CLOUDFLARE_API_TOKEN`) work as a fallback, but every process Claude starts inherits them. Prefer the plugin option.
- **The advanced file** refuses a token.
- **Token scope:** use a token from **Workers AI → Use REST API → Create a Workers AI API Token**, which grants only Workers AI. Do not reuse a broader Cloudflare token.

## What the mod can do on your machine

Mods run with your permissions. `claude plugin validate .` lists everything this one touches.

- **Network:** `$.http.fetch`, to the Clef endpoint only.
- **Files:** `$.fs.read` of the advanced file, the rubric file and its own logs; `$.fs.write` and `$.fs.list` of its log directory.
- **Engine:** `$.env.get` of the variables listed in [Configuration](CONFIGURATION.md#environment-variables), plus `HOME`, `USERPROFILE` and `CLAUDE_CONFIG_DIR` to locate files. It also reads settings (only `promptCacheTtl` is used), the session's model, id and usage, its own state and store, the clock, the status line, toasts, and the `/clef` command.

It runs no processes, approves no tool calls, and does not rewrite your prompt other than removing a `+target` prefix you typed. Apart from removing that prefix, it never changes what Claude reads. The only change to a request is its model and effort.

## Dependencies

There are no runtime dependencies: the mod is TypeScript the engine loads directly. Development uses `typescript` and `@types/node`, and Node's built-in test runner.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
