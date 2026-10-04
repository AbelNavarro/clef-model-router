// Explicit user intent, parsed deterministically: the one-turn `+target`
// prompt prefix, `/clef` command targets, and turns that only continue the
// previous one. No model is involved in any of this.

import { splitTarget } from "./config.ts"
import { isAlias, isEffort } from "./models.ts"
import { LEVELS, type Level, type Target, type TurnKind } from "./types.ts"

/**
 * Parses a target: a profile (`hard`), an alias or model ID with an optional
 * effort (`opus`, `opus:max`, `claude-sonnet-5-5:low`), or an effort alone
 * (`:high`). Undefined when the text is none of those.
 */
export function parseTarget(text: string): Target | undefined {
  const t = text.trim()
  if (t === "") return undefined
  if (t.startsWith(":")) {
    const effort = t.slice(1).toLowerCase()
    return isEffort(effort) ? { effort } : undefined
  }
  const { model, effort, badEffort } = splitTarget(t)
  if (badEffort || model === "") return undefined
  const lower = model.toLowerCase()
  const target: Target = {}
  if ((LEVELS as readonly string[]).includes(lower)) target.level = lower as Level
  else if (isAlias(lower)) target.model = lower
  else if (/^claude-[a-z0-9.-]+(\[1m\])?$/i.test(model) || /anthropic\./i.test(model)) target.model = model
  else return undefined
  if (effort) target.effort = effort
  return target
}

export type PrefixResult = { text: string; override?: Target | "off" }

const PREFIX = /^\+(\S+)(?:\s+|$)/

/**
 * A prompt that starts with `+target ` routes that one turn to the target and
 * reaches Claude without the prefix; `+off ` runs the turn as Claude Code
 * would. Anything else (`+1`, `+x`) is left untouched.
 */
export function parsePrefix(text: string): PrefixResult {
  const match = PREFIX.exec(text)
  if (!match) return { text }
  const token = match[1]!
  const rest = text.slice(match[0].length)
  if (token.toLowerCase() === "off" || token.toLowerCase() === "noroute") return { text: rest, override: "off" }
  const target = parseTarget(token)
  if (!target) return { text }
  return { text: rest, override: target }
}

/** Words a go-ahead is made of ("yes, do it", "ok go ahead", "lgtm, ship it"). */
const GO_AHEAD_WORDS = new Set([
  "y", "ya", "yes", "yep", "yeah", "yup", "ok", "okay", "k", "sure", "alright", "fine", "cool", "great", "perfect",
  "go", "ahead", "for", "it", "do", "that", "this", "continue", "proceed", "carry", "on", "keep", "going", "next",
  "lgtm", "looks", "sounds", "good", "ship", "please", "approved", "approve", "confirm", "confirmed", "thanks",
])
/** A go-ahead says yes to something; "it", "on" or "good" alone do not. */
const GO_AHEAD_ANCHORS = new Set([
  "y", "ya", "yes", "yep", "yeah", "yup", "ok", "okay", "k", "sure", "alright", "go", "do", "continue", "proceed",
  "carry", "keep", "next", "lgtm", "ship", "approved", "approve", "confirm", "confirmed", "sounds", "looks",
])

/** Classifies a turn's text before anything is asked of Clef. */
export function turnKind(text: string): TurnKind {
  const t = text.trim()
  if (t === "") return "empty"
  if (t.startsWith("<task-notification>")) return "notification"
  if (t.length <= 40) {
    const words = t.toLowerCase().replace(/[.,!;:'"]+/g, " ").split(/\s+/).filter(Boolean)
    if (words.length > 0 && words.length <= 6 && words.every((w) => GO_AHEAD_WORDS.has(w)) && words.some((w) => GO_AHEAD_ANCHORS.has(w)))
      return "go-ahead"
  }
  return "prompt"
}

export type ClefCommand =
  | { kind: "status" }
  | { kind: "history" }
  | { kind: "stats"; days: number }
  | { kind: "profiles" }
  | { kind: "test"; prompt: string }
  | { kind: "auto" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "pin"; target: Target }
  | { kind: "feedback"; verdict: "under" | "ok" | "over"; note?: string }
  | { kind: "help" }
  | { kind: "error"; message: string }

const FEEDBACK: Record<string, "under" | "ok" | "over"> = {
  under: "under",
  underpowered: "under",
  weak: "under",
  "too-weak": "under",
  ok: "ok",
  right: "ok",
  good: "ok",
  over: "over",
  overpowered: "over",
  strong: "over",
  "too-strong": "over",
}

export function parseCommand(args: string): ClefCommand {
  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim()
  switch (head) {
    case "":
    case "status":
      return { kind: "status" }
    case "history":
    case "log":
      return { kind: "history" }
    case "stats": {
      const days = rest === "" ? 7 : Number(rest)
      return Number.isInteger(days) && days > 0 && days <= 366
        ? { kind: "stats", days }
        : { kind: "error", message: "usage: /clef stats [days]" }
    }
    case "profiles":
      return { kind: "profiles" }
    case "test":
      return rest === "" ? { kind: "error", message: "usage: /clef test <prompt>" } : { kind: "test", prompt: rest }
    case "auto":
    case "unpin":
      return { kind: "auto" }
    case "on":
      return { kind: "on" }
    case "off":
      return { kind: "off" }
    case "pin": {
      const target = parseTarget(rest)
      return target
        ? { kind: "pin", target }
        : { kind: "error", message: `usage: /clef pin <${LEVELS.join("|")}|haiku|sonnet|opus|fable|model-id>[:effort] or /clef pin :<effort>` }
    }
    case "feedback": {
      const space2 = rest.search(/\s/)
      const word = (space2 === -1 ? rest : rest.slice(0, space2)).toLowerCase()
      const verdict = FEEDBACK[word]
      if (!verdict) return { kind: "error", message: "usage: /clef feedback under|ok|over [note]" }
      const note = space2 === -1 ? "" : rest.slice(space2 + 1).trim()
      return note ? { kind: "feedback", verdict, note } : { kind: "feedback", verdict }
    }
    case "help":
      return { kind: "help" }
    default: {
      // `/clef opus:high` as shorthand for `/clef pin opus:high`.
      const target = parseTarget(trimmed)
      return target ? { kind: "pin", target } : { kind: "error", message: `unknown subcommand "${head}"; try /clef help` }
    }
  }
}

export type NativeEffort = {
  /** The effort Claude Code sent when the router started watching. */
  baseline?: string | number
  /** An effort the person set with /effort since, in force until /clef auto. */
  native?: string | number
}

/**
 * Tracks the effort Claude Code itself would send, seen at each turn's first
 * request. A change from the baseline is the person's /effort (or a skill's
 * `effort` for one turn): it is honoured, and dropped again when the engine's
 * effort returns to the baseline, so a one-turn skill does not stick.
 */
export function trackNativeEffort(prev: NativeEffort, engine: string | number | undefined): NativeEffort & { change?: "set" | "cleared" } {
  const keep = (): NativeEffort => ({
    ...(prev.baseline !== undefined ? { baseline: prev.baseline } : {}),
    ...(prev.native !== undefined ? { native: prev.native } : {}),
  })
  if (engine === undefined) return keep()
  if (prev.baseline === undefined) return { baseline: engine }
  if (engine === prev.native) return keep()
  if (engine === prev.baseline) return prev.native === undefined ? keep() : { baseline: prev.baseline, change: "cleared" }
  return { baseline: prev.baseline, native: engine, change: "set" }
}
