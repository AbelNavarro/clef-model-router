// The questions Clef is asked. This is the calibration surface: change the
// wording here (or point `rubric_file` at a JSON file with the same shape)
// and nothing else needs to change. `npm run calibrate` shows the effect.
//
// Clef answers every question in one forward pass, so the second question
// costs a few extra input tokens and no extra latency.

import { LEVELS } from "./types.ts"

export type Rubric = {
  /** What Clef is asked to rate. The prompt itself is sent as the `state`. */
  instructions: string
  /** One description per level, lowest first; exactly five. */
  levels: readonly string[]
  /** The follow-up question; empty string to not ask it. */
  followUp: string
}

export const DEFAULT_RUBRIC: Rubric = {
  instructions:
    "A developer sent this message to Claude Code, an AI coding agent working inside their software " +
    "repository with tools to read, search, edit and run code. Rate how much model capability and " +
    "reasoning effort the agent needs to do this well. Judge the work the message asks for, not the " +
    "length of the message: a short request can be hard, and a long paste can still be a trivial task.",
  levels: [
    "Trivial: mechanical and obvious, no judgment. Fix a typo, rename one symbol, reformat, run a known " +
      "command, answer a quick factual or yes/no question, find where something is defined.",
    "Simple: a small, well-specified change or question in one place. A one-line fix with a clear cause, " +
      "add a log line or one simple test, explain a short function, a small config edit.",
    "Moderate: ordinary feature or bug work with a clear goal, a few files, following existing patterns. " +
      "Add an endpoint or pagination, write tests for a module, fix a reproducible bug, a routine refactor.",
    "Hard: tricky, ambiguous or multi-step work where a wrong answer is costly. Debug intermittent, " +
      "concurrency or non-obvious failures, significant refactors, unfamiliar code, performance, " +
      "security-sensitive changes, choosing between designs.",
    "Very hard: open-ended investigation or design across a whole subsystem. Root-cause cascading or " +
      "distributed failures, architecture or migration plans, weigh alternatives then implement and " +
      "verify, long autonomous work.",
  ],
  followUp:
    "Is this message a short follow-up whose actual task is defined by earlier conversation rather than " +
    "by the message itself, such as 'yes do it', 'try again', 'go with option 2', 'that didn't work', " +
    "or 'continue'?",
}

export type ClefQuestion =
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }

export type QuestionStyle = "score" | "choice"

/** Question IDs, shared by the request builder and the response parser. */
export const Q_DIFFICULTY = "difficulty"
export const Q_FOLLOW_UP = "follow_up"

/**
 * Builds Clef's question map. `score` (the default) treats the levels as an
 * ordered rubric, which is what they are; `choice` is kept so calibration can
 * compare the two on the same corpus.
 */
export function buildQuestions(rubric: Rubric, style: QuestionStyle = "score"): Record<string, ClefQuestion> {
  const questions: Record<string, ClefQuestion> = {}
  questions[Q_DIFFICULTY] =
    style === "score"
      ? { type: "score", instructions: rubric.instructions, criteria: [...rubric.levels] }
      : {
          type: "choice",
          instructions: rubric.instructions,
          criteria: Object.fromEntries(LEVELS.map((level, i) => [level, rubric.levels[i]!])),
        }
  if (rubric.followUp.trim() !== "") {
    questions[Q_FOLLOW_UP] = {
      type: "noul",
      instructions: rubric.followUp,
      criteria: {
        true: "The message only makes sense together with earlier conversation.",
        false: "The message states a self-contained request.",
      },
    }
  }
  return questions
}

/** Validates a rubric loaded from a file; returns the problems found. */
export function rubricProblems(value: unknown): string[] {
  const problems: string[] = []
  if (typeof value !== "object" || value === null) return ["rubric must be a JSON object"]
  const r = value as Record<string, unknown>
  if (typeof r.instructions !== "string" || r.instructions.trim() === "") problems.push("`instructions` must be a non-empty string")
  if (!Array.isArray(r.levels) || r.levels.length !== LEVELS.length || !r.levels.every((l) => typeof l === "string" && l.trim() !== ""))
    problems.push(`\`levels\` must be ${LEVELS.length} non-empty strings, lowest first`)
  if (r.followUp !== undefined && typeof r.followUp !== "string") problems.push("`followUp` must be a string when present")
  return problems
}

export function parseRubric(text: string): { rubric: Rubric } | { problems: string[] } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { problems: ["rubric file is not valid JSON"] }
  }
  const problems = rubricProblems(value)
  if (problems.length > 0) return { problems }
  const r = value as { instructions: string; levels: string[]; followUp?: string }
  return { rubric: { instructions: r.instructions, levels: r.levels, followUp: r.followUp ?? DEFAULT_RUBRIC.followUp } }
}
