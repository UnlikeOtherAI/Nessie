import { Prisma } from '@prisma/client'
import {
  applyDeepWaterScopeResult,
  applyDeepWaterStatusRead,
  blockDeepWaterDelivery,
  failUnstartedDeepWaterBrief,
  readDeepWaterBriefRun,
  settleStaleDeepWaterAction,
  type DeepWaterBriefRun,
  type DeepWaterProjectionOutcome,
} from '@nessie/runtime'
import {
  LedgerResearchStatusDtoSchema,
  LedgerScopeResultSchema,
  deepWaterBriefActionJobKey,
  toLedgerBriefSettings,
  type DeepWaterRunWatchJobPayload,
} from '@nessie/schemas'

import {
  callDeepWaterLedgerTool,
  deepWaterAgentOriginAttribution,
  deepWaterSystemAttribution,
  isTransientLedgerRefusal,
  type DeepWaterLedgerOutcome,
} from '../run/deepwater-ledger-call.js'
import { runDeepWaterTransaction } from './deepwater-announce.js'
import {
  failedKickoff,
  failedNotice,
  identityChangedOnAgentBriefNotice,
  identityChangedWhileRunningNotice,
} from './deepwater-copy.js'
import { deliverDeepWaterResearch, type DeepWaterDeliveryDeps } from './deepwater-delivery.js'
import { deepWaterTopicPreview, ensureDeepWaterResearchCard, postDeepWaterNotice } from './deepwater-messages.js'
import { handleDeepWaterTurnWake } from './deepwater-turn-wake.js'
import { wakeDeepWaterAgent } from './deepwater-wake.js'

/**
 * One read of an open DeepWater run through Ledger (Water plan
 * amendments-fable F1), claimed by the watch sweep. A brief being agreed is
 * read with `research_scope_get`, a research with `research_status`; every
 * answer goes through the same projection the tool acks use, then the watch
 * does what the new state owes: wake the agent a settled turn belongs to, post
 * a card a launch still lacks, end an action whose job is gone, or deliver a
 * finished research. An agent's brief that never got a research id is found
 * by replaying its `research_scope_start` with the agent's own tool-call id.
 *
 * Every call is a cost-free control-plane read (contract §8). A transient
 * failure changes nothing: the claim already scheduled the next read.
 */

export type DeepWaterWatchDeps = DeepWaterDeliveryDeps

const log = (run: DeepWaterBriefRun, what: string): void => {
  console.info(`[deep-water] watch ${run.id}: ${what}`)
}

/** Did Ledger's refusal or silence leave nothing to do but read again later? */
const retryLater = (run: DeepWaterBriefRun, outcome: Exclude<DeepWaterLedgerOutcome, { outcome: 'ok' }>): void => {
  if (outcome.outcome === 'refused' && !isTransientLedgerRefusal(outcome.error)) {
    console.error(`[deep-water] watch ${run.id}: Ledger refused the read (${outcome.error.code})`)
    return
  }
  if (outcome.outcome === 'malformed') {
    console.error(`[deep-water] watch ${run.id}: ${outcome.reason}`)
    return
  }
  if (outcome.outcome === 'connector_missing') {
    // The team's connector is paused or gone while the run is open; the read
    // waits for it rather than guessing another route to Ledger.
    console.warn(`[deep-water] watch ${run.id}: the team's DeepWater connector is not active`)
    return
  }
  log(run, `read deferred (${outcome.outcome})`)
}

/**
 * The requester's captured identity no longer resolves (F4). The block stops
 * the watch until their next live action (or Retry) renews it. A person's own
 * brief says "Sign in again" in its dialog, from the run itself, so it needs
 * no notice. Everyone else is told once, because nothing else would tell them:
 * an agent's brief waits on a person who cannot edit it and an agent that is
 * never woken again, and a launched research is still running — never told as
 * finished.
 */
const blockOnIdentity = async (deps: DeepWaterWatchDeps, run: DeepWaterBriefRun): Promise<void> => {
  await runDeepWaterTransaction(deps, async (tx, announce) => {
    const blocked = await blockDeepWaterDelivery(tx, {
      organizationId: run.organizationId,
      runId: run.id,
      reason: 'requester_identity_changed',
    })
    if (!blocked) return
    announce.run(run)
    const brief = run.status === 'drafting'
    if (brief && run.originKind === 'person') return
    const topic = deepWaterTopicPreview(run)
    await postDeepWaterNotice(tx, announce, run, {
      kind: 'blocked',
      content: brief ? identityChangedOnAgentBriefNotice(topic) : identityChangedWhileRunningNotice(topic),
      alertKey: `deep-water-identity:${run.id}:${run.reconcileSeq}`,
    })
  })
}

/** An action's job is live while it is queued or running. */
const isActionJobLive = async (deps: DeepWaterWatchDeps, run: DeepWaterBriefRun, actionId: string) => {
  const rows = await deps.prisma.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT "status" FROM "queue_jobs" WHERE "idempotency_key" = ${deepWaterBriefActionJobKey(run.id, actionId)}
  `)
  return rows.some((row) => row.status === 'pending' || row.status === 'processing')
}

/**
 * Apply one Ledger read in its own transaction, announcing the run when a
 * viewer would see the change.
 */
const applyRead = (
  deps: DeepWaterWatchDeps,
  apply: (tx: Prisma.TransactionClient) => Promise<DeepWaterProjectionOutcome>,
): Promise<DeepWaterProjectionOutcome> =>
  runDeepWaterTransaction(deps, async (tx, announce) => {
    const outcome = await apply(tx)
    if (outcome.applied && outcome.changed) announce.run(outcome.run)
    return outcome
  })

/** What an applied read owes, done in one transaction per effect. */
const followUp = async (deps: DeepWaterWatchDeps, run: DeepWaterBriefRun, applied: DeepWaterProjectionOutcome) => {
  if (!applied.applied) return
  const next = applied.run
  await runDeepWaterTransaction(deps, (tx, announce) => handleDeepWaterTurnWake(tx, announce, next))
  if (applied.launched || next.status === 'running') {
    await runDeepWaterTransaction(deps, (tx, announce) => ensureDeepWaterResearchCard(tx, announce, {
      organizationId: next.organizationId,
      runId: next.id,
    }))
  }
  const action = next.scopeState?.pendingAction
  if (action && action.error === null && !await isActionJobLive(deps, next, action.actionId)) {
    const settled = await runDeepWaterTransaction(deps, async (tx, announce) => {
      const outcome = await settleStaleDeepWaterAction(tx, {
        organizationId: next.organizationId,
        runId: next.id,
        actionId: action.actionId,
      })
      if (outcome !== 'none' && outcome !== 'kept') announce.run(next)
      return outcome
    })
    if (settled !== 'none' && settled !== 'kept') log(run, `stale ${action.kind} action ${settled}`)
  }
  if (applied.ledgerTerminal) {
    const result = await deliverDeepWaterResearch(deps, {
      organizationId: next.organizationId,
      runId: next.id,
      terminal: applied.ledgerTerminal,
    })
    log(run, `delivery ${result}`)
  }
}

type Identity = NonNullable<DeepWaterBriefRun['uoaIdentity']>

const turnOpen = (run: DeepWaterBriefRun): boolean => {
  const turn = run.scopeState?.turn
  return turn != null && (turn.status === 'pending' || turn.status === 'dispatching')
}

/** The stored transcript is older than the stored brief, or there is no brief yet. */
const transcriptStale = (run: DeepWaterBriefRun): boolean => {
  const brief = run.scopeState?.brief
  return !brief || brief.messagesRevision === null || brief.messagesRevision < brief.revision
}

const readBrief = async (
  deps: DeepWaterWatchDeps,
  run: DeepWaterBriefRun,
  identity: Identity,
  connectorId: string,
) => {
  const read = async (includeTranscript: boolean, suffix: string) => {
    const answer = await callDeepWaterLedgerTool(deps, {
      organizationId: run.organizationId,
      connectorId,
      attribution: deepWaterSystemAttribution(run, { systemComponent: 'deep-water.delivery', identity }),
      toolCallId: `watch:${run.id}:${run.reconcileSeq}${suffix}`,
      toolName: 'research_scope_get',
      args: { id: run.externalRunId, include_transcript: includeTranscript },
    })
    if (answer.outcome === 'identity') {
      await blockOnIdentity(deps, run)
      return null
    }
    if (answer.outcome !== 'ok') {
      retryLater(run, answer)
      return null
    }
    const parsed = LedgerScopeResultSchema.safeParse(answer.structured)
    if (!parsed.success) {
      retryLater(run, { outcome: 'malformed', reason: 'research_scope_get answered outside the contract' })
      return null
    }
    return applyRead(deps, (tx) => applyDeepWaterScopeResult(tx, {
      organizationId: run.organizationId,
      runId: run.id,
      result: parsed.data,
    }))
  }
  // The transcript is read only when the brief may have moved (F1): while a
  // planner turn is open its reply is not written yet.
  const withTranscript = transcriptStale(run) && !turnOpen(run)
  const applied = await read(withTranscript, '')
  if (!applied) return
  await followUp(deps, run, applied)
  // A read that found the planner's answer without its transcript fetches the
  // transcript at once, so the conversation never lags the brief.
  if (
    !withTranscript
    && applied.applied
    && applied.run.status === 'drafting'
    && transcriptStale(applied.run)
    && !turnOpen(applied.run)
  ) {
    const filled = await read(true, ':transcript')
    if (filled) await followUp(deps, run, filled)
  }
}

const readResearch = async (
  deps: DeepWaterWatchDeps,
  run: DeepWaterBriefRun,
  identity: Identity,
  connectorId: string,
) => {
  const read = await callDeepWaterLedgerTool(deps, {
    organizationId: run.organizationId,
    connectorId,
    attribution: deepWaterSystemAttribution(run, { systemComponent: 'deep-water.delivery', identity }),
    toolCallId: `watch:${run.id}:${run.reconcileSeq}`,
    toolName: 'research_status',
    args: { id: run.externalRunId },
  })
  if (read.outcome === 'identity') return blockOnIdentity(deps, run)
  if (read.outcome !== 'ok') return retryLater(run, read)
  const parsed = LedgerResearchStatusDtoSchema.safeParse(read.structured)
  if (!parsed.success) return retryLater(run, { outcome: 'malformed', reason: 'research_status answered outside the contract' })
  const applied = await applyRead(deps, (tx) => applyDeepWaterStatusRead(tx, {
    organizationId: run.organizationId,
    runId: run.id,
    status: parsed.data,
  }))
  await followUp(deps, run, applied)
}

/**
 * An agent's `research_scope_start` whose result never came back: replay it
 * as that same call (the agent's Run, agent and provider tool-call id, and the
 * arguments it sent), which Ledger answers with the one brief it keyed to the
 * call — or opens it now, which is what the agent asked for. A definitive
 * refusal ends the brief and tells the agent.
 */
const replayAgentScopeStart = async (
  deps: DeepWaterWatchDeps,
  run: DeepWaterBriefRun,
  identity: Identity,
  connectorId: string,
) => {
  const agentId = run.originAgentId
  const agent = agentId
    ? await deps.prisma.agent.findFirst({
        where: { id: agentId, organizationId: run.organizationId },
        select: { agentKind: true },
      })
    : null
  if (!agentId || !agent || !run.input || !run.originToolCallId) {
    return log(run, 'origin agent or call is gone; the reap will end it')
  }
  const input = run.input
  const read = await callDeepWaterLedgerTool(deps, {
    organizationId: run.organizationId,
    connectorId,
    attribution: deepWaterAgentOriginAttribution(run, { agentKind: agent.agentKind, identity }),
    toolCallId: run.originToolCallId,
    toolName: 'research_scope_start',
    args: {
      topic: input.topic,
      ...(input.context ? { context: input.context } : {}),
      ...(input.pillars ? { pillars: input.pillars } : {}),
      ...(input.settings ? { settings: toLedgerBriefSettings(input.settings) } : {}),
    },
  })
  if (read.outcome === 'refused' && !isTransientLedgerRefusal(read.error)) {
    const topic = deepWaterTopicPreview(run)
    const failureCode = read.error.code.replace(/[^a-z_]/g, '_').slice(0, 64) || 'start_rejected'
    await runDeepWaterTransaction(deps, async (tx, announce) => {
      const failed = await failUnstartedDeepWaterBrief(tx, {
        organizationId: run.organizationId,
        runId: run.id,
        failureCode,
        // An agent's brief has no person's action in flight; the agent hears it by the wake.
        actionErrorCode: 'rejected',
      })
      if (!failed) return
      announce.run(run)
      const wake = await wakeDeepWaterAgent(tx, run, {
        agentId,
        kind: 'failed',
        turnId: null,
        content: failedKickoff({ topic, failureCode }),
      })
      if (wake.kind === 'unreachable') {
        await postDeepWaterNotice(tx, announce, run, { kind: 'failed', content: failedNotice({ topic, failureCode }) })
      }
    })
    return log(run, `scope start refused (${read.error.code})`)
  }
  if (read.outcome !== 'ok') return retryLater(run, read)
  const parsed = LedgerScopeResultSchema.safeParse(read.structured)
  if (!parsed.success) return retryLater(run, { outcome: 'malformed', reason: 'research_scope_start answered outside the contract' })
  const applied = await runDeepWaterTransaction(deps, async (tx, announce) => {
    const outcome = await applyDeepWaterScopeResult(tx, {
      organizationId: run.organizationId,
      runId: run.id,
      result: parsed.data,
    })
    if (outcome.applied && outcome.changed) announce.run(outcome.run)
    // N1: the agent's research card is posted with the attach.
    if (outcome.applied && outcome.attached) {
      await ensureDeepWaterResearchCard(tx, announce, { organizationId: run.organizationId, runId: run.id })
    }
    return outcome
  })
  await followUp(deps, run, applied)
}

/**
 * Read one open run and do what its new state owes. Shared by the watch job
 * and a person's retry of a blocked delivery; a blocked or legacy run is left
 * alone.
 */
export const watchDeepWaterRun = async (deps: DeepWaterWatchDeps, run: DeepWaterBriefRun): Promise<void> => {
  if (!run.uoaIdentity || run.deliveryBlockedReason) return
  if (!run.connectorId) {
    // A brief is bound to its connector at creation and a disable waits for
    // it, so this is a broken invariant, not a state to work around.
    console.error(`[deep-water] watch ${run.id}: the run has lost its connector`)
    return
  }
  if (run.externalRunId === null) {
    if (run.status === 'queued' && run.originKind === 'agent') {
      await replayAgentScopeStart(deps, run, run.uoaIdentity, run.connectorId)
    }
    return
  }
  if (run.status === 'drafting') return readBrief(deps, run, run.uoaIdentity, run.connectorId)
  if (run.status === 'running' || run.status === 'needs_setup') {
    return readResearch(deps, run, run.uoaIdentity, run.connectorId)
  }
}

export const runDeepWaterWatch = async (
  deps: DeepWaterWatchDeps,
  payload: DeepWaterRunWatchJobPayload,
): Promise<void> => {
  const run = await readDeepWaterBriefRun(deps.prisma, payload)
  // A newer claim supersedes this one.
  if (!run || run.reconcileSeq !== payload.reconcileSeq) return
  await watchDeepWaterRun(deps, run)
}
