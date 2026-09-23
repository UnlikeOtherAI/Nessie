import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'

import {
  blockDeepWaterDelivery,
  claimDeepWaterDelivery,
  readDeepWaterBriefRun,
  recordDeepWaterDeliveryMessage,
  refreshDeepWaterRunIdentity,
  type DeepWaterBriefRun,
  type DeepWaterLedgerTerminal,
} from '@nessie/runtime'
import {
  LedgerResearchReportSchema,
  type DeepWaterDeliveryBlockedReason,
  type DeepWaterRequesterIdentity,
} from '@nessie/schemas'

import {
  DEEP_WATER_REPORT_TIMEOUT_MS,
  callDeepWaterLedgerTool,
  deepWaterSystemAttribution,
  isTransientLedgerRefusal,
  type DeepWaterLedgerCallDeps,
} from '../run/deepwater-ledger-call.js'
import {
  blockedNotice,
  completedKickoff,
  failedKickoff,
  failedNotice,
  resultNotice,
  wakeUnreachableNotice,
} from './deepwater-copy.js'
import { deepWaterTopicPreview, postDeepWaterNotice } from './deepwater-messages.js'
import {
  ensureDeepWaterReportPage,
  resolveDeepWaterReportDestination,
  storeDeepWaterArtifacts,
  type DeepWaterImportDeps,
} from './deepwater-report-import.js'
import { wakeDeepWaterAgent } from './deepwater-wake.js'

/**
 * Delivering a finished research exactly once (Water plan amendments N3): the
 * steps safe to repeat (read the report, store its artifacts, import it into
 * Documents), then the terminal effects in the one transaction that wins the
 * delivery claim — the person's result reply with its alert, or the wake of
 * the agent that asked. A delivery that cannot finish is blocked once, with one
 * notice naming the remedy; a transient failure changes nothing and the watch
 * tries again.
 */

export type DeepWaterDeliveryDeps = DeepWaterLedgerCallDeps & DeepWaterImportDeps

export type DeepWaterDeliveryResult = 'delivered' | 'already' | 'blocked' | 'retry'

/** Record the message the claimed delivery wrote: the person's reply, or the agent's wake kickoff. */
const recordMessage = (
  tx: Prisma.TransactionClient,
  run: DeepWaterBriefRun,
  message: { resultMessageId: string } | { wakeMessageId: string },
) => recordDeepWaterDeliveryMessage(tx, { organizationId: run.organizationId, runId: run.id, ...message })

const block = async (
  deps: DeepWaterDeliveryDeps,
  run: DeepWaterBriefRun,
  reason: DeepWaterDeliveryBlockedReason,
): Promise<DeepWaterDeliveryResult> => {
  await deps.prisma.$transaction(async (tx) => {
    if (!await blockDeepWaterDelivery(tx, { organizationId: run.organizationId, runId: run.id, reason })) return
    // One notice per blocked attempt: the block is claimed once per attempt.
    await postDeepWaterNotice(tx, run, {
      kind: 'blocked',
      content: blockedNotice({ topic: deepWaterTopicPreview(run), reason }),
      alertKey: `deep-water-blocked:${run.id}:${randomUUID()}`,
    })
  })
  return 'blocked'
}

const deliverFailure = async (
  deps: DeepWaterDeliveryDeps,
  run: DeepWaterBriefRun,
  terminal: DeepWaterLedgerTerminal,
): Promise<DeepWaterDeliveryResult> => {
  const failureCode = terminal.errorCode ?? terminal.status
  const topic = deepWaterTopicPreview(run)
  return deps.prisma.$transaction(async (tx) => {
    const claimed = await claimDeepWaterDelivery(tx, {
      organizationId: run.organizationId,
      runId: run.id,
      outcome: { kind: 'failed', failureCode },
    })
    if (!claimed) return 'already'
    if (run.originKind === 'agent' && run.originAgentId) {
      const wake = await wakeDeepWaterAgent(tx, run, {
        agentId: run.originAgentId,
        kind: 'failed',
        turnId: null,
        content: failedKickoff({ topic, failureCode }),
      })
      if (wake.kind !== 'unreachable') {
        await recordMessage(tx, run, { wakeMessageId: wake.kickoffId })
        return 'delivered'
      }
      console.warn(`[deep-water] wake unreachable (${wake.reason}) for run ${run.id}`)
    }
    const notice = await postDeepWaterNotice(tx, run, {
      kind: 'failed',
      content: failedNotice({ topic, failureCode }),
    })
    if (notice) {
      await recordMessage(tx, run, { resultMessageId: notice.messageId })
    }
    return 'delivered'
  })
}

/**
 * Deliver the research `run` finished with. `identity` is a person's live
 * identity when they retried a blocked delivery; it renews the captured one
 * only for the same person, organisation and team.
 */
export const deliverDeepWaterResearch = async (
  deps: DeepWaterDeliveryDeps,
  input: {
    organizationId: string
    runId: string
    terminal: DeepWaterLedgerTerminal
    identity?: DeepWaterRequesterIdentity | null
  },
): Promise<DeepWaterDeliveryResult> => {
  const liveIdentity = input.identity
  if (liveIdentity) {
    await deps.prisma.$transaction((tx) => refreshDeepWaterRunIdentity(tx, {
      organizationId: input.organizationId,
      runId: input.runId,
      identity: liveIdentity,
    }))
  }
  const run = await readDeepWaterBriefRun(deps.prisma, input)
  // Launcher runs (no captured identity) are delivered by their own handoff.
  if (!run?.uoaIdentity || !run.externalRunId || run.deliveredAt || run.deliveryBlockedReason) return 'already'
  if (input.terminal.status !== 'complete') return deliverFailure(deps, run, input.terminal)
  if (!run.connectorId) {
    // A brief is bound to its connector at creation and a disable waits for
    // it, so this is a broken invariant, not a state to work around.
    console.error(`[deep-water] run ${run.id} lost its connector before delivery`)
    return 'retry'
  }

  const read = await callDeepWaterLedgerTool(deps, {
    organizationId: run.organizationId,
    connectorId: run.connectorId,
    attribution: deepWaterSystemAttribution(run, {
      systemComponent: 'deep-water.delivery',
      identity: run.uoaIdentity,
    }),
    toolCallId: `delivery:${run.id}:report`,
    toolName: 'research_report',
    args: { id: run.externalRunId },
    timeoutMs: DEEP_WATER_REPORT_TIMEOUT_MS,
  })
  if (read.outcome === 'identity') return block(deps, run, 'requester_identity_changed')
  if (read.outcome === 'connector_missing') {
    console.warn(`[deep-water] delivery of ${run.id} waits: the team's DeepWater connector is not active`)
    return 'retry'
  }
  if (read.outcome === 'unavailable') return 'retry'
  if (read.outcome === 'malformed') return block(deps, run, 'report_malformed')
  if (read.outcome === 'refused') {
    if (read.error.statusCode === 410 || read.error.code === 'expired') return block(deps, run, 'report_expired')
    if (isTransientLedgerRefusal(read.error)) return 'retry'
    console.error(`[deep-water] research_report refused (${read.error.code}) for run ${run.id}`)
    return block(deps, run, 'ledger_unavailable')
  }
  const parsed = LedgerResearchReportSchema.safeParse(read.structured)
  if (!parsed.success) return block(deps, run, 'report_malformed')
  const report = parsed.data

  const title = run.title ?? report.title ?? run.input?.topic ?? run.queryPreview
  const destination = await resolveDeepWaterReportDestination(deps.prisma, run)
  if (!destination) return block(deps, run, 'knowledge_destination_unavailable')
  const files = await storeDeepWaterArtifacts(deps, run, { report, title, projectId: destination.projectId })
  const page = await ensureDeepWaterReportPage(deps, run, {
    destination,
    reportFileId: files.reportFileId,
    report,
    title,
  })
  if (page.kind === 'blocked') return block(deps, run, 'knowledge_destination_unavailable')

  const topic = deepWaterTopicPreview(run)
  const sourceCount = report.references.length
  return deps.prisma.$transaction(async (tx) => {
    const claimed = await claimDeepWaterDelivery(tx, {
      organizationId: run.organizationId,
      runId: run.id,
      outcome: {
        kind: 'completed',
        knowledgePageId: page.pageId,
        sourceCount,
        reportKind: report.reportKind,
        truncated: report.truncated,
        publicUrl: report.publicUrl,
        title: report.title,
      },
    })
    if (!claimed) return 'already'
    const link = `/knowledge-base?spaceId=${page.spaceId}&pageId=${page.pageId}`
    if (run.originKind === 'agent' && run.originAgentId) {
      const wake = await wakeDeepWaterAgent(tx, run, {
        agentId: run.originAgentId,
        kind: 'completed',
        turnId: null,
        content: completedKickoff({ sourceCount, pageId: page.pageId, reportKind: report.reportKind }),
      })
      if (wake.kind !== 'unreachable') {
        await recordMessage(tx, run, { wakeMessageId: wake.kickoffId })
        return 'delivered'
      }
      console.warn(`[deep-water] wake unreachable (${wake.reason}) for run ${run.id}`)
      const notice = await postDeepWaterNotice(tx, run, {
        kind: 'wake_unreachable',
        content: wakeUnreachableNotice({ topic, finished: true, link }),
      })
      if (notice) {
        await recordMessage(tx, run, { resultMessageId: notice.messageId })
      }
      return 'delivered'
    }
    const reply = await postDeepWaterNotice(tx, run, {
      kind: 'result',
      content: resultNotice({
        topic,
        sourceCount,
        pageId: page.pageId,
        spaceId: page.spaceId,
        reportKind: report.reportKind,
        truncated: report.truncated,
      }),
    })
    if (reply) {
      await recordMessage(tx, run, { resultMessageId: reply.messageId })
    }
    return 'delivered'
  })
}
