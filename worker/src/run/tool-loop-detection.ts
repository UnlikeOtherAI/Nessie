/**
 * Loop detection, decided before dispatch.
 *
 * Every tool gets the cumulative rule: the third identical call (same name,
 * same arguments) anywhere in the run is short-circuited. Observation tools
 * are the exception. Watching something that takes time means asking the same
 * question again, so for them only **consecutive** identical calls count, any
 * other call in between resets the streak, and the fourth in a row is the one
 * refused.
 */

/** Tools that only look. Later tools that wait on or list work join here. */
export const OBSERVATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  // `executorToolName('mcp.tools')`, spelled out so this module stays free of
  // the executor toolset's imports; a test pins that the two agree.
  'executor_mcp_tools',
])

export const LOOP_DETECTION_THRESHOLD = 3
export const OBSERVATION_LOOP_THRESHOLD = 4

export const REPEATED_CALL_NUDGE =
  'You are repeating the same tool call. Stop and produce a final answer with the information you already have.'
export const REPEATED_OBSERVATION_NUDGE =
  'The result has not changed. Wait with a different call, or tell the person where things stand and end your turn.'

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

const REPEATED_OBSERVATION: LoopVerdict = {
  nudge: REPEATED_OBSERVATION_NUDGE,
  output: `Not run: this exact call was already made ${OBSERVATION_LOOP_THRESHOLD - 1} times in a row, `
    + 'with nothing else in between.',
}

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
  const streakKey = `${OBSERVE_KEY_PREFIX}${signature}`
  const streak = (counts.get(streakKey) ?? 0) + 1
  // Any call ends every streak it does not continue, so at most one survives.
  for (const key of [...counts.keys()]) {
    if (key.startsWith(OBSERVE_KEY_PREFIX)) counts.delete(key)
  }
  if (OBSERVATION_TOOL_NAMES.has(toolName)) {
    counts.set(streakKey, streak)
    return streak >= OBSERVATION_LOOP_THRESHOLD ? REPEATED_OBSERVATION : null
  }
  const repeatKey = `${REPEAT_KEY_PREFIX}${signature}`
  const count = (counts.get(repeatKey) ?? 0) + 1
  counts.set(repeatKey, count)
  return count >= LOOP_DETECTION_THRESHOLD ? REPEATED_CALL : null
}

/** One nudge per batch; a plain repeat outranks a repeated observation. */
export const strongerNudge = (current: string | null, verdict: LoopVerdict): string =>
  current === REPEATED_CALL_NUDGE ? current : verdict.nudge
