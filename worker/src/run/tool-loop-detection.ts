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
 * A wait is the one observation that is not refused for being repeated:
 * waiting on a coding agent that is still working means calling the same wait
 * again, and that is the tool working as meant. It reports after it ran
 * (`noteWatchProgress`) whether what it watched moved and why it stopped
 * waiting. While the session works, its streak counts only the waits that saw
 * **no progress**, and the third such wait in a row earns a nudge rather than
 * a refusal. A wait that stopped because the model has to act is different:
 * waiting again returns the same answer at once, so another wait on that
 * session with no acting call in between is refused, however its arguments
 * are written, and so is every wait once the person has written or the run's
 * time runs low, for the rest of the run.
 */

/**
 * The coding-session tools that only look, spelled out so this module stays
 * free of the executor toolset's imports; a test pins that they agree with
 * `CODING_SESSION_TOOL_NAMES`.
 */
export const CODING_OBSERVATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'coding_session_list',
  'terminal_session_read',
  'coding_session_review',
  'coding_session_wait',
])

/** Observation tools whose repeats are expected while they watch: nudged when they stop seeing progress. */
export const WATCH_TOOL_NAMES: ReadonlySet<string> = new Set(['coding_session_wait'])

/**
 * Why a watch tool stopped waiting. `watching`: what it watches is still busy
 * (or did not answer in time), and waiting again is expected. `needs_model`:
 * it stopped because the model has to act — the turn ended, the session was
 * interrupted, failed or closed. `end_turn`: the person wrote or stopped the
 * run, or the run's own time is running low, and the model should end its turn.
 */
export type WatchState = 'end_turn' | 'needs_model' | 'watching'

/** What a watch tool reports once it ran (`AgenticToolResult.watch`). */
export type WatchReport = {
  /** Whether what it waited on moved while it waited. */
  progressed: boolean
  state: WatchState
}

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
export const CODING_REPEATED_LOOK_NUDGE =
  'The coding session\'s answer has not changed. If it is working, call coding_session_wait; if it is waiting for '
  + 'you, send it feedback or close it; otherwise tell the person where things stand and end your turn.'
export const CODING_WAIT_NEEDS_YOU_NUDGE =
  'Waiting again will not change the coding session: it is not working, and the last wait on it said why. Act on '
  + 'that answer — review it, send it a message or close it — or tell the person where it stands and end your turn.'
export const CODING_WAIT_END_TURN_NUDGE =
  'Stop waiting and end your turn now with one line saying where the coding session stands: the person has '
  + 'written, or this run is nearly out of time.'

// The checkpoint keys. Counts written before observation tools had their own
// rule carry neither prefix, and a resumed run drops them: a cumulative count
// read back as a consecutive streak would refuse a call the new rule allows.
// `#` never appears in a tool name, so no unprefixed key can look like these.
const REPEAT_KEY_PREFIX = '#repeat:'
const OBSERVE_KEY_PREFIX = '#observe:'
// A wait that stopped because the model must act, by the session it waited on;
// ended by any call that is not an observation, since only such a call can
// change what the wait would see.
const SETTLED_KEY_PREFIX = '#settled:'
// A wait that stopped because the turn is over (the person wrote, or the run is
// nearly out of time), by tool name: every later wait would stop for the same reason.
const ENDED_KEY_PREFIX = '#ended:'

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
  nudge: CODING_REPEATED_LOOK_NUDGE,
  output: REPEATED_OBSERVATION_OUTPUT,
}

const WAIT_NEEDS_YOU: LoopVerdict = {
  nudge: CODING_WAIT_NEEDS_YOU_NUDGE,
  output: 'Not run: your last wait on this session already returned because it needs you, and nothing you did '
    + 'since can have changed that, so waiting again would return the same answer.',
}

const WAIT_AFTER_TURN_ENDED: LoopVerdict = {
  nudge: CODING_WAIT_END_TURN_NUDGE,
  output: 'Not run: the person has written, or this run is nearly out of time, so every wait this turn would stop '
    + 'at once. End your turn now with one line of status.',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// The session a wait names, read as execution reads it: the whole arguments
// object may arrive as a JSON string (`coerceToolArgumentsToSchema`), and a key
// the tool does not define is left behind. Parsed here rather than imported, so
// this module stays free of the builtin tool catalog that parser loads.
const sessionOf = (args: unknown): unknown => {
  let value = args
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      value = JSON.parse(value.trim())
    } catch {
      return undefined
    }
  }
  return isRecord(value) ? value.sessionId : undefined
}

// A wait's keys name the session, not the arguments' text: an extra key, a
// reordering or a double-encoded object is still the same wait on the machine,
// so neither a settled wait nor a stall streak starts over for one.
const watchKeyOf = (prefix: string, toolName: string, args: unknown): string =>
  `${prefix}${toolName}:${JSON.stringify(sessionOf(args) ?? null)}`

const streakKeyOf = (toolName: string, args: Record<string, unknown>): string => (
  WATCH_TOOL_NAMES.has(toolName)
    ? watchKeyOf(OBSERVE_KEY_PREFIX, toolName, args)
    : `${OBSERVE_KEY_PREFIX}${toolName}:${JSON.stringify(args)}`
)
const settledKeyOf = (toolName: string, args: Record<string, unknown>): string =>
  watchKeyOf(SETTLED_KEY_PREFIX, toolName, args)
const endedKeyOf = (toolName: string): string => `${ENDED_KEY_PREFIX}${toolName}`

const RESTORED_KEY_PREFIXES = [REPEAT_KEY_PREFIX, OBSERVE_KEY_PREFIX, SETTLED_KEY_PREFIX, ENDED_KEY_PREFIX]

// A wait's key checkpointed when it still named the whole arguments object,
// `#settled:coding_session_wait:{"sessionId":"a"}`, under the session it names.
const restoredKeyOf = (key: string): string => {
  const prefix = [SETTLED_KEY_PREFIX, OBSERVE_KEY_PREFIX].find((candidate) => key.startsWith(candidate))
  if (!prefix) return key
  const rest = key.slice(prefix.length)
  const toolName = rest.slice(0, rest.indexOf(':'))
  if (!WATCH_TOOL_NAMES.has(toolName)) return key
  try {
    const written: unknown = JSON.parse(rest.slice(toolName.length + 1))
    return isRecord(written) ? watchKeyOf(prefix, toolName, written) : key
  } catch {
    return key
  }
}

/**
 * The counts a resumed run may keep, without those written under the old
 * rule. A wait's keys written by the whole arguments object are carried over
 * by the session they name, so a wait settled before the resume stays settled.
 */
export const restoreLoopCounts = (saved: Record<string, number> | undefined): Map<string, number> =>
  new Map(Object.entries(saved ?? {})
    .filter(([key]) => RESTORED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .map(([key, count]) => [restoredKeyOf(key), count]))

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
  const observation = OBSERVATION_TOOL_NAMES.has(toolName)
  // Any call ends every streak it does not continue, so at most one survives;
  // a call that can change something also ends every settled wait.
  for (const key of [...counts.keys()]) {
    if (key.startsWith(OBSERVE_KEY_PREFIX) || (!observation && key.startsWith(SETTLED_KEY_PREFIX))) {
      counts.delete(key)
    }
  }
  if (WATCH_TOOL_NAMES.has(toolName)) {
    // Counted here so another call in between still ends it; a watching wait
    // is judged only once it says whether it saw anything move.
    counts.set(streakKey, streak)
    if (counts.has(endedKeyOf(toolName))) return WAIT_AFTER_TURN_ENDED
    return counts.has(settledKeyOf(toolName, args)) ? WAIT_NEEDS_YOU : null
  }
  if (observation) {
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
 * A watch tool's own report, after it ran. The turn being over — the person
 * wrote, or the run's time runs low — settles every later wait in the run. A
 * wait that stopped because the model must act settles every wait on that
 * session until an acting call. A watching wait that saw progress restarts
 * its streak, and the third in a row that saw none returns the nudge (and
 * restarts it, so the next nudge is three stalled waits away). A call whose
 * streak another call already ended — a later call in the same batch — counts
 * for nothing, except that the turn is still over.
 */
export const noteWatchProgress = (
  counts: Map<string, number>,
  toolName: string,
  args: Record<string, unknown>,
  report: WatchReport,
): string | null => {
  if (!WATCH_TOOL_NAMES.has(toolName)) return null
  if (report.state === 'end_turn') counts.set(endedKeyOf(toolName), 1)
  const streakKey = streakKeyOf(toolName, args)
  const streak = counts.get(streakKey)
  if (streak === undefined || report.state === 'end_turn') return null
  if (report.state === 'needs_model') {
    // The wait's own answer says what to do; only a repeat of it is refused.
    counts.set(settledKeyOf(toolName, args), 1)
    counts.set(streakKey, 0)
    return null
  }
  if (report.progressed || streak >= WATCH_STALL_THRESHOLD) counts.set(streakKey, 0)
  return !report.progressed && streak >= WATCH_STALL_THRESHOLD ? CODING_NO_PROGRESS_NUDGE : null
}

/** One nudge per batch; a plain repeat outranks a repeated observation. */
export const strongerNudge = (current: string | null, verdict: LoopVerdict | string): string => {
  const nudge = typeof verdict === 'string' ? verdict : verdict.nudge
  return current === REPEATED_CALL_NUDGE ? current : nudge
}
