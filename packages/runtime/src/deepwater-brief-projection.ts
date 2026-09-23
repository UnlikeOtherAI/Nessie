import { Prisma } from '@prisma/client'
import {
  DEEP_WATER_REAPED_FAILURE_CODES,
  DeepWaterScopeStateSchema,
  type DeepWaterScopeState,
  type DeepWaterTurnAuthor,
  type DeepWaterTurnRegister,
  type LedgerResearchStatus,
  type LedgerResearchStatusDto,
  type LedgerResearchTicket,
  type LedgerScopeResult,
  type ProductIntegrationRunStatus,
} from '@nessie/schemas'

import {
  applyScopeResultToState,
  deepWaterWatchDelayMs,
  isPendingActionInFlight,
  productRunStatusForLedger,
} from './deepwater-brief-registers.js'
import {
  deepWaterBriefJson,
  deepWaterMsSinceLastEvent,
  lockDeepWaterBriefRun,
  type DeepWaterBriefDb,
  type DeepWaterBriefRun,
} from './deepwater-brief-run-record.js'
import { DEEP_WATER_PRODUCT_SLUG } from './integration-runs-mapping.js'

/**
 * Applying what Ledger says about a brief to its product run, under the row
 * lock (Water plan amendments N1, N2, F1, F8).
 *
 * Every Ledger read reaches the run through one of three entries — a scope
 * result (a scope tool's ack or a watch read), a status read, or a launch
 * ticket — and all three share the same rules:
 *
 * - the Ledger research id attaches once (`attachScopeStart`), from whichever
 *   read arrives first, and never moves a row out of `running` or a terminal
 *   state;
 * - the brief projection only advances (the two registers), and so does the
 *   status: a read never moves a run back (`running` to `drafting`), because
 *   a read issued before a launch can be applied after its ticket;
 * - a run moves into its launched statuses only on proof of launch: a launch
 *   ticket, a brief whose own state is `launched`, `needs_setup`, or a
 *   `complete`. Ledger shows a launch in flight (`starting`) as `running`,
 *   and a launch Water refuses from there is reverted to `drafting`, so a bare
 *   `running` launches nothing — it would post a person's card to the room
 *   and open their brief to it for a launch that may yet be undone. The one
 *   real way back, Ledger reverting a launch Water refused, is known only to
 *   the launch job, which settles its action itself (`revertDeepWaterLaunch`);
 * - non-terminal Ledger statuses move the run forward; `cancelled` is written
 *   directly; a finished research (`complete`, `failed`, `timed_out`) is
 *   reported back as `ledgerTerminal` and written only by the delivery claim,
 *   so `completed` and `delivered_at` always land in one transaction — after
 *   moving a brief Ledger shows was launched to `running`, so its launch is
 *   seen before its result;
 * - the title is captured as soon as Ledger reports it;
 * - the watch is rescheduled from the new state.
 */

/** The run is bound to one Ledger research and a read named another. */
export class DeepWaterResearchIdMismatchError extends Error {
  override readonly name = 'DeepWaterResearchIdMismatchError'

  constructor(readonly runId: string, readonly boundResearchId: string, readonly incomingResearchId: string) {
    super(`DeepWater run ${runId} is bound to ${boundResearchId} but a Ledger read named ${incomingResearchId}`)
  }
}

/** Ledger returned a research id another product run already holds. */
export class DeepWaterResearchIdTakenError extends Error {
  override readonly name = 'DeepWaterResearchIdTakenError'

  constructor(readonly runId: string, readonly researchId: string, readonly holderRunId: string) {
    super(`DeepWater research ${researchId} is already bound to run ${holderRunId}, not ${runId}`)
  }
}

export type DeepWaterLedgerTerminal = {
  status: Extract<LedgerResearchStatus, 'complete' | 'failed' | 'timed_out'>
  errorCode: string | null
}

export type DeepWaterProjectionOutcome =
  | { applied: false; reason: 'not_found' | 'not_attachable' | 'terminal' }
  | {
      applied: true
      run: DeepWaterBriefRun
      /** This read bound the Ledger research id to the run. */
      attached: boolean
      /** Anything a viewer sees changed: publish `integration.run.updated`. */
      changed: boolean
      /** The planner turn this read settled, for the per-turn wake claim (N4). */
      newlySettledTurn: DeepWaterTurnRegister | null
      pendingActionCleared: boolean
      /**
       * The run was launched with this read — it moved into `running` or
       * `needs_setup` — so `launched_at` is set and a person-origin card may
       * be owed.
       */
      launched: boolean
      /** Ledger reports a finished research: the caller runs delivery (N3). */
      ledgerTerminal: DeepWaterLedgerTerminal | null
    }

const TERMINAL_RUN_STATUSES: ReadonlySet<ProductIntegrationRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'warning',
])

/** A brief the reap gave up, never refused: a late confirmation still attaches it. */
const isRevivable = (run: DeepWaterBriefRun): boolean =>
  run.status === 'failed' && run.failureCode !== null && DEEP_WATER_REAPED_FAILURE_CODES.has(run.failureCode)

/** N1: a run takes its Ledger research id only while nothing else could have. */
const isAttachable = (run: DeepWaterBriefRun): boolean =>
  run.externalRunId === null
  && (run.status === 'queued' || run.status === 'drafting' || isRevivable(run))

const requireBriefState = (run: DeepWaterBriefRun): DeepWaterScopeState => {
  if (run.scopeState === null) {
    // Legacy launcher rows carry neither identity nor brief; the brief flow
    // never selects them, so reaching one here is a caller bug.
    throw new Error(`DeepWater run ${run.id} is a legacy launcher run, not a research brief`)
  }
  return run.scopeState
}

/** The author of a brief's opening turn is whoever opened the brief (N1). */
const originTurnAuthor = (run: DeepWaterBriefRun): DeepWaterTurnAuthor | null => {
  if (run.originKind === 'agent') {
    return run.originAgentId ? { kind: 'agent', agentId: run.originAgentId } : null
  }
  return run.requestedByUserId ? { kind: 'person', userId: run.requestedByUserId } : null
}

type StatusStep = {
  status: ProductIntegrationRunStatus
  ledgerTerminal: DeepWaterLedgerTerminal | null
  /**
   * Ledger shows the research running but the read carries no proof of
   * launch yet: the run keeps its status and is read at a running research's
   * pace, so the proof (or the revert) is seen within seconds.
   */
  awaitingProof: boolean
}

/**
 * The order a live run's status moves in. `running` and `needs_setup` share a
 * rank: an operator's `needs_setup` and its recovery are both forward.
 */
const STATUS_RANK: Record<ProductIntegrationRunStatus, number> = {
  queued: 0,
  drafting: 1,
  running: 2,
  needs_setup: 2,
  cancelled: 3,
  completed: 3,
  failed: 3,
  warning: 3,
}

/**
 * The live statuses only a launched research reaches: Ledger reports
 * `needs_setup` only for a launched job (from `starting` or `running`), so a
 * brief that moves straight from `drafting` to `needs_setup` was launched too,
 * and its card and room are owed exactly as for `running`.
 */
const LAUNCHED_STATUSES: ReadonlySet<ProductIntegrationRunStatus> = new Set(['running', 'needs_setup'])

/**
 * What a Ledger status does to a live run's product status (contract §2.4);
 * never backwards, and into a launched status only on proof of launch.
 *
 * `launched` is that proof from the read itself: a launch ticket, or a brief
 * whose own state is `launched` (Water launched it, which nothing reverts).
 * `needs_setup` and `complete` are proof on their own — Ledger reports
 * `needs_setup` only for a launched research and finishes only launched
 * research. A bare `running` is not: Ledger shows `starting` as `running`
 * while the launch call is still out, and reverts it to `drafting` when Water
 * refuses the launch, so moving on it would post a person's card and open
 * their brief to the room for a launch that is then undone. A bare `failed`
 * is not either: it can be a refusal before launch.
 *
 * A finished research is written by the delivery claim, but one with proof of
 * launch moves to `running` first when Nessie never saw it run (a launch ack
 * lost, or a research that finished between two reads): the launch is what
 * posts a person's card and opens the run to its room, and a result must never
 * be delivered to a room that was not shown the research.
 */
const statusStepForLedger = (
  current: ProductIntegrationRunStatus,
  ledger: LedgerResearchStatus,
  errorCode: string | null,
  launched: boolean,
): StatusStep => {
  if (ledger === 'complete' || ledger === 'failed' || ledger === 'timed_out') {
    const status = (launched || ledger === 'complete') && STATUS_RANK[current] < STATUS_RANK.running
      ? 'running'
      : current
    return { status, ledgerTerminal: { status: ledger, errorCode }, awaitingProof: false }
  }
  const next = productRunStatusForLedger(ledger)
  if (STATUS_RANK[next] < STATUS_RANK[current]) return { status: current, ledgerTerminal: null, awaitingProof: false }
  // Moving between `running` and `needs_setup` is not a launch; moving into
  // `running` from a brief is, and needs its proof.
  if (next === 'running' && !launched && !LAUNCHED_STATUSES.has(current)) {
    return { status: current, ledgerTerminal: null, awaitingProof: true }
  }
  return { status: next, ledgerTerminal: null, awaitingProof: false }
}

/**
 * An in-flight action ends with the brief or the research: once either is
 * cancelled or finished, nothing is left for it to do. A launch is otherwise
 * finished only by its own ticket (or `revertDeepWaterLaunch`): a read that
 * sees the research `running` cannot tell whether the launch call has
 * returned.
 */
const pendingActionFinishedByStatus = (
  state: DeepWaterScopeState,
  status: ProductIntegrationRunStatus,
  ledgerTerminal: DeepWaterLedgerTerminal | null,
): boolean =>
  isPendingActionInFlight(state.pendingAction)
  && (status === 'cancelled' || ledgerTerminal !== null)

const assertBoundTo = (run: DeepWaterBriefRun, researchId: string): void => {
  if (run.externalRunId !== null && run.externalRunId !== researchId) {
    throw new DeepWaterResearchIdMismatchError(run.id, run.externalRunId, researchId)
  }
}

const assertResearchIdFree = async (
  tx: DeepWaterBriefDb,
  run: DeepWaterBriefRun,
  researchId: string,
): Promise<void> => {
  // Checked before the write rather than caught after it: a unique violation
  // would abort the caller's whole transaction.
  const holder = await tx.productIntegrationRun.findFirst({
    where: { productSlug: DEEP_WATER_PRODUCT_SLUG, externalRunId: researchId, id: { not: run.id } },
    select: { id: true },
  })
  if (holder) {
    throw new DeepWaterResearchIdTakenError(run.id, researchId, holder.id)
  }
}

type ProjectionWrite = {
  run: DeepWaterBriefRun
  now: Date
  attachResearchId: string | null
  state: DeepWaterScopeState
  status: ProductIntegrationRunStatus
  /** Read at a running research's pace while Ledger shows one without proof (`StatusStep`). */
  awaitingProof: boolean
  title: string | null
  contentChanged: boolean
}

/** Write one projection step and reschedule the watch from the result. */
const writeProjection = async (
  tx: DeepWaterBriefDb,
  write: ProjectionWrite,
): Promise<{ run: DeepWaterBriefRun; changed: boolean; launched: boolean }> => {
  const { run, now } = write
  const statusChanged = write.status !== run.status
  const titleChanged = write.title !== run.title
  const changed = write.contentChanged || statusChanged || titleChanged || write.attachResearchId !== null
  const observedAt = changed ? now : run.ledgerObservedAt
  const delayMs = deepWaterWatchDelayMs({
    status: write.awaitingProof ? 'running' : write.status,
    state: write.state,
    msSinceLastChange: now.getTime() - observedAt.getTime(),
    msSinceLastEvent: deepWaterMsSinceLastEvent(run, now),
  })
  // The move into a launched status is the launch, whichever one Ledger
  // reported; moving between them (an operator's `needs_setup` and its
  // recovery) is not a second launch.
  const launched = LAUNCHED_STATUSES.has(write.status) && !LAUNCHED_STATUSES.has(run.status)

  const data: Prisma.ProductIntegrationRunUpdateInput = {
    scopeJson: deepWaterBriefJson(DeepWaterScopeStateSchema.parse(write.state)),
    status: write.status,
    title: write.title,
    ledgerObservedAt: observedAt,
    reconcileAfter: new Date(now.getTime() + delayMs),
  }
  if (write.attachResearchId !== null) {
    data.externalRunId = write.attachResearchId
    data.failureCode = null
    data.completedAt = null
  }
  if (launched) {
    data.launchedAt = run.launchedAt ?? now
  }
  if (write.status === 'cancelled' && statusChanged) {
    data.completedAt = now
  }
  await tx.productIntegrationRun.update({ where: { id: run.id }, data })

  const next = await lockDeepWaterBriefRun(tx, { organizationId: run.organizationId, runId: run.id })
  if (!next) throw new Error(`DeepWater run ${run.id} vanished under its own row lock`)
  return { run: next.run, changed, launched }
}

export type ApplyDeepWaterScopeResultInput = {
  organizationId: string
  runId: string
  result: LedgerScopeResult
  /** The in-flight person action this result is the tool result of. */
  ackActionId?: string | null
  /** The author of `result.turn` when this is that author's own content-bearing call. */
  turnAuthor?: DeepWaterTurnAuthor | null
}

/**
 * Apply one ScopeResult — a scope tool's ack or a watch read. The first read
 * that names the research attaches it (`attachScopeStart`): an ack, a watch
 * read and a revival after the reaper all converge on the same row.
 */
export const applyDeepWaterScopeResult = async (
  tx: DeepWaterBriefDb,
  input: ApplyDeepWaterScopeResultInput,
): Promise<DeepWaterProjectionOutcome> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  if (!locked) return { applied: false, reason: 'not_found' }
  const { run, now } = locked
  const state = requireBriefState(run)
  const result = input.result

  const attaching = run.externalRunId === null
  if (attaching) {
    if (!isAttachable(run)) return { applied: false, reason: 'not_attachable' }
    await assertResearchIdFree(tx, run, result.id)
  } else {
    assertBoundTo(run, result.id)
    if (TERMINAL_RUN_STATUSES.has(run.status)) return { applied: false, reason: 'terminal' }
  }

  const openingAuthor = result.turn?.seq === 1 ? originTurnAuthor(run) : null
  const application = applyScopeResultToState(state, result, {
    ackActionId: input.ackActionId ?? null,
    turnAuthor: input.turnAuthor ?? openingAuthor,
  })

  // The attach makes the run `drafting` (N1) — a queued row, or one the reap
  // gave up, whose reap the attach undoes — and Ledger's status moves it on from
  // there. So an attach that already names a finished research leaves the row
  // where the watch claims it: a delivery that does not finish now is retried
  // by the next claim instead of stranding an attached `queued` row.
  const from: ProductIntegrationRunStatus = attaching ? 'drafting' : run.status
  const step = statusStepForLedger(from, result.status, result.errorCode, result.brief?.state === 'launched')
  const finishedByStatus = pendingActionFinishedByStatus(application.state, step.status, step.ledgerTerminal)
  const nextState = finishedByStatus ? { ...application.state, pendingAction: null } : application.state

  const written = await writeProjection(tx, {
    run,
    now,
    attachResearchId: attaching ? result.id : null,
    state: nextState,
    status: step.status,
    awaitingProof: step.awaitingProof,
    title: result.title ?? run.title,
    contentChanged: application.changed || finishedByStatus,
  })
  return {
    applied: true,
    run: written.run,
    attached: attaching,
    changed: written.changed,
    newlySettledTurn: application.newlySettledTurn,
    pendingActionCleared: application.pendingActionCleared || finishedByStatus,
    launched: written.launched,
    ledgerTerminal: step.ledgerTerminal,
  }
}

/** Apply a `research_status` read of a bound run. */
export const applyDeepWaterStatusRead = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; status: LedgerResearchStatusDto },
): Promise<DeepWaterProjectionOutcome> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  if (!locked) return { applied: false, reason: 'not_found' }
  const { run, now } = locked
  const state = requireBriefState(run)
  if (run.externalRunId === null) return { applied: false, reason: 'not_attachable' }
  assertBoundTo(run, input.status.id)
  if (TERMINAL_RUN_STATUSES.has(run.status)) return { applied: false, reason: 'terminal' }

  const step = statusStepForLedger(run.status, input.status.status, input.status.errorCode, false)
  const finishedByStatus = pendingActionFinishedByStatus(state, step.status, step.ledgerTerminal)
  const nextState = finishedByStatus ? { ...state, pendingAction: null } : state
  const written = await writeProjection(tx, {
    run,
    now,
    attachResearchId: null,
    state: nextState,
    status: step.status,
    awaitingProof: step.awaitingProof,
    title: input.status.title ?? run.title,
    contentChanged: finishedByStatus,
  })
  return {
    applied: true,
    run: written.run,
    attached: false,
    changed: written.changed,
    newlySettledTurn: null,
    pendingActionCleared: finishedByStatus,
    launched: written.launched,
    ledgerTerminal: step.ledgerTerminal,
  }
}

/**
 * Apply the ticket `research_scope_launch` returned. The ticket names the
 * research the brief already is; anything else is a Ledger contract violation.
 * A launch ack after a watch read already moved the run on changes nothing.
 */
export const applyDeepWaterLaunchTicket = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; ticket: LedgerResearchTicket; ackActionId?: string | null },
): Promise<DeepWaterProjectionOutcome> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  if (!locked) return { applied: false, reason: 'not_found' }
  const { run, now } = locked
  const state = requireBriefState(run)
  if (run.externalRunId === null) return { applied: false, reason: 'not_attachable' }
  assertBoundTo(run, input.ticket.id)
  if (TERMINAL_RUN_STATUSES.has(run.status)) return { applied: false, reason: 'terminal' }

  // A ticket is Ledger's answer to a launch: the research was launched.
  const step = statusStepForLedger(run.status, input.ticket.status, null, true)
  const action = state.pendingAction
  const acked = isPendingActionInFlight(action)
    && action.kind === 'launch'
    && (input.ackActionId === undefined || input.ackActionId === null || action.actionId === input.ackActionId)
  const finished = acked || pendingActionFinishedByStatus(state, step.status, step.ledgerTerminal)
  const nextState = finished ? { ...state, pendingAction: null } : state
  const written = await writeProjection(tx, {
    run,
    now,
    attachResearchId: null,
    state: nextState,
    status: step.status,
    awaitingProof: step.awaitingProof,
    title: run.title,
    contentChanged: finished,
  })
  return {
    applied: true,
    run: written.run,
    attached: false,
    changed: written.changed,
    newlySettledTurn: null,
    pendingActionCleared: finished,
    launched: written.launched,
    ledgerTerminal: step.ledgerTerminal,
  }
}
