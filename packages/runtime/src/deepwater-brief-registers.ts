import type {
  DeepWaterBriefRegister,
  DeepWaterPendingAction,
  DeepWaterScopeState,
  DeepWaterTurnAuthor,
  DeepWaterTurnRegister,
  LedgerResearchStatus,
  LedgerScopeBrief,
  LedgerScopeResult,
  LedgerScopeTurn,
  LedgerScopeTurnStatus,
  ProductIntegrationRunStatus,
} from '@nessie/schemas'

/**
 * The brief projection as two monotone registers (Water plan amendments N2).
 *
 * Reads, tool results and watch reads arrive in any order and more than once.
 * Each register may only advance, so the order they are applied in cannot
 * matter and a stale read can never roll the projection back:
 *
 *   (a) brief content — replaced only by a strictly greater `revision`; its
 *       transcript is a sub-register ordered by (revision, last message seq),
 *       so a read without the transcript never erases one;
 *   (b) planner turn  — replaced only by a lexicographically greater
 *       `(seq, rank(status))`; a settled turn is immutable.
 *
 * Pure functions: the database module applies them under the row lock.
 */

/** Ledger reported two different turns under one sequence number. */
export class DeepWaterTurnSequenceConflictError extends Error {
  override readonly name = 'DeepWaterTurnSequenceConflictError'

  constructor(readonly seq: number, readonly storedTurnId: string, readonly incomingTurnId: string) {
    super(`DeepWater planner turn ${seq} is ${storedTurnId} here but Ledger reported ${incomingTurnId}`)
  }
}

const TURN_STATUS_RANK: Record<LedgerScopeTurnStatus, number> = {
  dispatching: 0,
  pending: 1,
  complete: 2,
  failed: 2,
  cancelled: 2,
}

export const isSettledTurnStatus = (status: LedgerScopeTurnStatus): boolean =>
  TURN_STATUS_RANK[status] === 2

export const isOpenTurn = (turn: DeepWaterTurnRegister | null): boolean =>
  turn !== null && !isSettledTurnStatus(turn.status)

const toTurnRegister = (turn: LedgerScopeTurn): DeepWaterTurnRegister => ({
  id: turn.id,
  seq: turn.seq,
  status: turn.status,
  errorCode: turn.errorCode,
  retryable: turn.retryable,
  authorKind: turn.authorKind,
})

/**
 * Advance register (b). Two turns under one sequence number is a Ledger
 * contract violation (`@@unique([researchJobId, seq])`), never a race, so it
 * throws rather than letting either turn win.
 */
export const advanceTurnRegister = (
  current: DeepWaterTurnRegister | null,
  incoming: LedgerScopeTurn,
): { turn: DeepWaterTurnRegister; advanced: boolean } => {
  if (current === null || incoming.seq > current.seq) {
    return { turn: toTurnRegister(incoming), advanced: true }
  }
  if (incoming.seq < current.seq) {
    return { turn: current, advanced: false }
  }
  if (incoming.id !== current.id) {
    throw new DeepWaterTurnSequenceConflictError(incoming.seq, current.id, incoming.id)
  }
  if (TURN_STATUS_RANK[incoming.status] > TURN_STATUS_RANK[current.status]) {
    return { turn: toTurnRegister(incoming), advanced: true }
  }
  return { turn: current, advanced: false }
}

const lastMessageSeq = (messages: ReadonlyArray<{ seq: string }>): bigint =>
  messages.reduce((max, message) => {
    const seq = BigInt(message.seq)
    return seq > max ? seq : max
  }, -1n)

const transcriptIsNewer = (
  current: DeepWaterBriefRegister,
  incomingRevision: number,
  incomingMessages: ReadonlyArray<{ seq: string }>,
): boolean => {
  const storedRevision = current.messagesRevision ?? -1
  if (incomingRevision !== storedRevision) return incomingRevision > storedRevision
  return lastMessageSeq(incomingMessages) > lastMessageSeq(current.messages)
}

/**
 * Advance register (a). Content moves only on a strictly greater revision; the
 * transcript moves independently whenever the read carried a newer one.
 */
export const advanceBriefRegister = (
  current: DeepWaterBriefRegister | null,
  incoming: LedgerScopeBrief,
): { brief: DeepWaterBriefRegister; contentAdvanced: boolean; transcriptAdvanced: boolean } => {
  const contentAdvanced = current === null || incoming.revision > current.revision
  const transcriptAdvanced = incoming.messages !== null
    && (current === null || transcriptIsNewer(current, incoming.revision, incoming.messages))

  const content = contentAdvanced
    ? {
        revision: incoming.revision,
        state: incoming.state,
        topic: incoming.topic,
        reply: incoming.reply,
        pillars: incoming.pillars,
        settings: incoming.settings,
        lockedSettings: incoming.lockedSettings,
        openQuestions: incoming.openQuestions,
        analysis: incoming.analysis,
        ready: incoming.ready,
      }
    : current
  const transcript = transcriptAdvanced && incoming.messages !== null
    ? { messages: incoming.messages, messagesRevision: incoming.revision }
    : { messages: current?.messages ?? [], messagesRevision: current?.messagesRevision ?? null }

  if (content === null) {
    // Unreachable: a null current always advances content.
    throw new Error('DeepWater brief register has no content to keep')
  }
  return {
    brief: {
      revision: content.revision,
      state: content.state,
      topic: content.topic,
      reply: content.reply,
      pillars: content.pillars,
      settings: content.settings,
      lockedSettings: content.lockedSettings,
      openQuestions: content.openQuestions,
      analysis: content.analysis,
      ready: content.ready,
      ...transcript,
    },
    contentAdvanced,
    transcriptAdvanced,
  }
}

export const isPendingActionInFlight = (action: DeepWaterPendingAction | null): action is DeepWaterPendingAction =>
  action !== null && action.error === null

/**
 * Does this settled turn finish the in-flight action? A reply matches the turn
 * its ack recorded; the opening `scope_start` matches turn 1 even before its
 * ack arrived, because a watch read may see the settled opening turn first.
 */
export const settledTurnFinishesAction = (
  action: DeepWaterPendingAction | null,
  turn: DeepWaterTurnRegister | null,
): boolean => {
  if (!isPendingActionInFlight(action) || turn === null || !isSettledTurnStatus(turn.status)) {
    return false
  }
  if (action.turnId !== null) return action.turnId === turn.id
  return action.kind === 'scope_start' && turn.seq === 1
}

export type ScopeResultApplication = {
  state: DeepWaterScopeState
  briefAdvanced: boolean
  turnAdvanced: boolean
  pendingActionCleared: boolean
  /** Register (b) when this application is what settled it; null otherwise. */
  newlySettledTurn: DeepWaterTurnRegister | null
  /** True when anything Nessie shows changed. */
  changed: boolean
}

export type ScopeResultApplicationInput = {
  /** The in-flight action this result acknowledges, when it is its tool result. */
  ackActionId?: string | null
  /**
   * Who wrote `result.turn`, when the caller is that author's own
   * content-bearing call. A read never passes one: its latest turn may be
   * somebody else's.
   */
  turnAuthor?: DeepWaterTurnAuthor | null
}

/**
 * Apply one Ledger ScopeResult to the stored scope state. Nothing is removed
 * except an in-flight action this result finishes.
 */
export const applyScopeResultToState = (
  state: DeepWaterScopeState,
  result: LedgerScopeResult,
  input: ScopeResultApplicationInput = {},
): ScopeResultApplication => {
  let turn = state.turn
  let turnAdvanced = false
  let newlySettledTurn: DeepWaterTurnRegister | null = null
  if (result.turn) {
    const wasSettled = turn !== null && turn.id === result.turn.id && isSettledTurnStatus(turn.status)
    const advanced = advanceTurnRegister(turn, result.turn)
    turn = advanced.turn
    turnAdvanced = advanced.advanced
    if (turnAdvanced && isSettledTurnStatus(turn.status) && !wasSettled) {
      newlySettledTurn = turn
    }
  }

  let brief = state.brief
  let briefAdvanced = false
  if (result.brief) {
    const advanced = advanceBriefRegister(brief, result.brief)
    brief = advanced.brief
    briefAdvanced = advanced.contentAdvanced || advanced.transcriptAdvanced
  }

  const turnAuthors = { ...state.turnAuthors }
  let authorsChanged = false
  if (result.turn && input.turnAuthor && turnAuthors[result.turn.id] === undefined) {
    turnAuthors[result.turn.id] = input.turnAuthor
    authorsChanged = true
  }

  let pendingAction = state.pendingAction
  let pendingActionCleared = false
  if (
    input.ackActionId
    && isPendingActionInFlight(pendingAction)
    && pendingAction.actionId === input.ackActionId
    && pendingAction.turnId === null
    && result.turn
    && (pendingAction.kind === 'reply' || pendingAction.kind === 'scope_start')
  ) {
    pendingAction = { ...pendingAction, turnId: result.turn.id }
  }
  if (settledTurnFinishesAction(pendingAction, turn)) {
    pendingAction = null
    pendingActionCleared = true
  }

  const pendingChanged = pendingAction !== state.pendingAction
  return {
    state: { brief, turn, turnAuthors, pendingAction },
    briefAdvanced,
    turnAdvanced,
    pendingActionCleared,
    newlySettledTurn,
    changed: briefAdvanced || turnAdvanced || authorsChanged || pendingChanged,
  }
}

/** Ledger status → Nessie product-run status (contract §2.4). */
export const productRunStatusForLedger = (
  status: LedgerResearchStatus,
): ProductIntegrationRunStatus => {
  switch (status) {
    case 'drafting':
      return 'drafting'
    case 'starting':
    case 'running':
      return 'running'
    case 'needs_setup':
      return 'needs_setup'
    case 'complete':
      return 'completed'
    case 'failed':
    case 'timed_out':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
  }
}

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS

/**
 * When the Ledger watch should next read this run (amendments-fable F1):
 * every 5 s while the planner or a person's action is in flight, every 30 s
 * while the research runs, otherwise backing off from the last change — half
 * the time since, at least 10 minutes and at most 6 hours.
 */
export const deepWaterWatchDelayMs = (input: {
  status: ProductIntegrationRunStatus
  state: DeepWaterScopeState | null
  msSinceLastChange: number
}): number => {
  if (input.state && (isOpenTurn(input.state.turn) || isPendingActionInFlight(input.state.pendingAction))) {
    return 5 * SECOND_MS
  }
  if (input.status === 'running') {
    return 30 * SECOND_MS
  }
  return Math.min(Math.max(Math.max(input.msSinceLastChange, 0) / 2, 10 * MINUTE_MS), 6 * HOUR_MS)
}
