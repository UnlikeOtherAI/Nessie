/**
 * Loop detection, decided before dispatch.
 *
 * Every tool gets the cumulative rule: the third identical call (same name,
 * same arguments) anywhere in the run is short-circuited. Observation tools
 * are the exception. Watching something that takes time means asking the same
 * question again, so for them only **consecutive** identical calls count, any
 * other call in between resets the streak, and the fourth in a row is the one
 * refused.
 *
 * A wait is the one observation that is never refused before it runs: waiting
 * on a coding agent means calling the same wait again, and that is the tool
 * working as meant. Its streak counts only the waits that saw **no progress**,
 * which the wait itself reports after it ran (`noteWatchProgress`), and the
 * third such wait in a row earns a nudge rather than a refusal.
 */

/**
 * The coding-session tools that only look, spelled out so this module stays
 * free of the executor toolset's imports; a test pins that they agree with
 * `CODING_SESSION_TOOL_NAMES`.
 */
export const CODING_OBSERVATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'coding_session_list',
  'coding_session_review',
  'coding_session_wait',
])

/** Observation tools whose repeats are expected: never refused, nudged when they stop seeing progress. */
export const WATCH_TOOL_NAMES: ReadonlySet<string> = new Set(['coding_session_wait'])

/** Tools that only look. Later tools that wait on or list work join here. */
export const OBSERVATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  // `executorToolName('mcp.tools')`, spelled out so this module stays free of
  // the executor toolset's imports; a test pins that the two agree.
  'executor_mcp_tools',
  ...CODING_OBSERVATION_TOOL_NAMES,
])

export const LOOP_DETECTION_THRESHOLD = 3
export const OBSERVATION_LOOP_THRESHOLD = 4
/** Waits in a row that saw nothing move before the loop says something. */
export const WATCH_STALL_THRESHOLD = 3

export const REPEATED_CALL_NUDGE =
  'You are repeating the same tool call. Stop and produce a final answer with the information you already have.'
export const REPEATED_OBSERVATION_NUDGE =
  'The result has not changed. Wait with a different call, or tell the person where things stand and end your turn.'
export const CODING_NO_PROGRESS_NUDGE =
  'The coding agent is still working; that is normal. Wait again, or tell the person where things stand and end your turn.'

// The checkpoint keys. Counts written before observation tools had their own
// rule carry neither prefix, and a resumed run drops them: a cumulative count
// read back as a consecutive streak would refuse a call the new rule allows.
// `#` never appears in a tool name, so no unprefixed key can look like these.
const REPEAT_KEY_PREFIX = '#repeat:'
const OBSERVE_KEY_PREFIX = '#observe:'

export type LoopVerdict = {
  /** What the loop tells the model after the batch. */
  nudge: string
  /** What the refused call answers with. */
  output: string
}

const REPEATED_CALL: LoopVerdict = {
  nudge: REPEATED_CALL_NUDGE,
  output: 'Tool call loop detected — this exact call has been repeated too many times. Try a different approach.',
}

const REPEATED_OBSERVATION_OUTPUT = `Not run: this exact call was already made ${OBSERVATION_LOOP_THRESHOLD - 1} times `
  + 'in a row, with nothing else in between.'

const REPEATED_OBSERVATION: LoopVerdict = { nudge: REPEATED_OBSERVATION_NUDGE, output: REPEATED_OBSERVATION_OUTPUT }

// Listing or reviewing a coding session over and over is waiting by other means.
const REPEATED_CODING_OBSERVATION: LoopVerdict = {
  nudge: CODING_NO_PROGRESS_NUDGE,
  output: REPEATED_OBSERVATION_OUTPUT,
}

const streakKeyOf = (toolName: string, args: Record<string, unknown>): string =>
  `${OBSERVE_KEY_PREFIX}${toolName}:${JSON.stringify(args)}`

/** The counts a resumed run may keep, without those written under the old rule. */
export const restoreLoopCounts = (saved: Record<string, number> | undefined): Map<string, number> =>
  new Map(Object.entries(saved ?? {}).filter(([key]) => (
    key.startsWith(REPEAT_KEY_PREFIX) || key.startsWith(OBSERVE_KEY_PREFIX)
  )))

/**
 * Count one call, in the order the model made it, and say whether it must be
 * refused. Mutates `counts`, which is the run's checkpointed state.
 */
export const countToolCall = (
  counts: Map<string, number>,
  toolName: string,
  args: Record<string, unknown>,
): LoopVerdict | null => {
  const signature = `${toolName}:${JSON.stringify(args)}`
  const streakKey = streakKeyOf(toolName, args)
  const streak = (counts.get(streakKey) ?? 0) + 1
  // Any call ends every streak it does not continue, so at most one survives.
  for (const key of [...counts.keys()]) {
    if (key.startsWith(OBSERVE_KEY_PREFIX)) counts.delete(key)
  }
  if (WATCH_TOOL_NAMES.has(toolName)) {
    // Counted here so another call in between still ends it; judged only
    // once the wait says whether it saw anything move.
    counts.set(streakKey, streak)
    return null
  }
  if (OBSERVATION_TOOL_NAMES.has(toolName)) {
    counts.set(streakKey, streak)
    if (streak < OBSERVATION_LOOP_THRESHOLD) return null
    return CODING_OBSERVATION_TOOL_NAMES.has(toolName) ? REPEATED_CODING_OBSERVATION : REPEATED_OBSERVATION
  }
  const repeatKey = `${REPEAT_KEY_PREFIX}${signature}`
  const count = (counts.get(repeatKey) ?? 0) + 1
  counts.set(repeatKey, count)
  return count >= LOOP_DETECTION_THRESHOLD ? REPEATED_CALL : null
}

/**
 * A watch tool's own report, after it ran: a wait that saw progress restarts
 * its streak, and the third in a row that saw none returns the nudge (and
 * restarts it, so the next nudge is three stalled waits away). A call whose
 * streak another call already ended counts for nothing.
 */
export const noteWatchProgress = (
  counts: Map<string, number>,
  toolName: string,
  args: Record<string, unknown>,
  progressed: boolean,
): string | null => {
  if (!WATCH_TOOL_NAMES.has(toolName)) return null
  const streakKey = streakKeyOf(toolName, args)
  const streak = counts.get(streakKey)
  if (streak === undefined) return null
  if (progressed || streak >= WATCH_STALL_THRESHOLD) counts.set(streakKey, 0)
  return !progressed && streak >= WATCH_STALL_THRESHOLD ? CODING_NO_PROGRESS_NUDGE : null
}

/** One nudge per batch; a plain repeat outranks a repeated observation. */
export const strongerNudge = (current: string | null, verdict: LoopVerdict | string): string => {
  const nudge = typeof verdict === 'string' ? verdict : verdict.nudge
  return current === REPEATED_CALL_NUDGE ? current : nudge
}
