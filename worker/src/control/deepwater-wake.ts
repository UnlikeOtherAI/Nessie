import { createHash } from 'node:crypto'

import type { Prisma } from '@prisma/client'
import { claimThreadRunOrPend } from '@nessie/db'
import {
  insertMessageBasis,
  insertMessageDisclosureSources,
  type DeepWaterBriefRun,
} from '@nessie/runtime'
import {
  DEEP_WATER_DELIVERY_PURPOSE,
  DeepWaterDeliveryMessageMetadataSchema,
  type DeepWaterDeliveryKind,
} from '@nessie/schemas'

import { buildAgentActorContext, startAgentRun } from './agent-run-start.js'
import { deepWaterReplyRoot } from './deepwater-messages.js'

/**
 * Waking the agent that asked for a research (Water plan amendments N4): one
 * hidden kickoff and one run per wake, never batched with other work, under
 * the identity of the person the agent asked for. Written inside the caller's
 * transaction, which already holds the product run's row lock.
 *
 * The kickoff id is deterministic per run, kind and turn, so a replayed job
 * reaches the same kickoff and the per-thread claim answers `duplicate`.
 */

type Tx = Prisma.TransactionClient

/** Formatted as the channel-policy kickoff id (`orchestrate-kickoff.ts`). */
export const deepWaterWakeKickoffId = (
  runId: string,
  kind: DeepWaterDeliveryKind,
  turnId: string | null,
): string => {
  const slot = kind === 'turn' ? turnId ?? '' : kind === 'start_unconfirmed' ? 'reap' : 'terminal'
  const hex = createHash('sha256').update(`nessie:deep-water:wake:${runId}:${kind}:${slot}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export type DeepWaterWakeOutcome =
  | { kind: 'claimed' | 'pended' | 'duplicate'; kickoffId: string }
  /** Nobody can be woken; the caller tells the person instead. */
  | { kind: 'unreachable'; reason: string }

const unreachable = (reason: string): DeepWaterWakeOutcome => ({ kind: 'unreachable', reason })

/**
 * Wake `agentId` in the run's origin thread with `content`. The kickoff sits
 * under the research card (F5), carries the run's full source basis and
 * private-conversation lineage (C2), and runs as the requester with their
 * captured identity.
 */
export const wakeDeepWaterAgent = async (
  tx: Tx,
  run: DeepWaterBriefRun,
  input: { agentId: string; kind: DeepWaterDeliveryKind; turnId: string | null; content: string },
): Promise<DeepWaterWakeOutcome> => {
  if (!run.threadId || !run.channelId) return unreachable('no origin thread')
  if (!run.requestedByUserId || !run.uoaIdentity) return unreachable('no requester identity')
  const [thread, agent, membership] = await Promise.all([
    tx.thread.findFirst({
      where: {
        id: run.threadId,
        channelId: run.channelId,
        channel: { organizationId: run.organizationId, deletedAt: null },
      },
      select: { channel: { select: { projectId: true } } },
    }),
    tx.agent.findFirst({ where: { id: input.agentId, organizationId: run.organizationId }, select: { id: true } }),
    tx.organizationMember.findFirst({
      where: { organizationId: run.organizationId, userId: run.requestedByUserId, deactivatedAt: null },
      select: { id: true },
    }),
  ])
  if (!thread) return unreachable('origin thread gone')
  if (!agent) return unreachable('agent gone')
  if (!membership) return unreachable('requester inactive')

  const kickoffId = deepWaterWakeKickoffId(run.id, input.kind, input.turnId)
  const root = await deepWaterReplyRoot(tx, run)
  const metadata = DeepWaterDeliveryMessageMetadataSchema.parse({
    deepWaterDelivery: { schemaVersion: 1, runId: run.id, kind: input.kind, turnId: input.turnId },
  })
  await tx.message.upsert({
    where: { id: kickoffId },
    update: {},
    create: {
      id: kickoffId,
      agentId: input.agentId,
      content: input.content,
      metadata: metadata as Prisma.InputJsonValue,
      role: 'system',
      threadId: run.threadId,
      ...(root ? { rootMessageId: root } : {}),
    },
    select: { id: true },
  })
  // The full, unsubtracted basis: the kickoff is never shown to people, and
  // the woken run admits it as its trigger's lineage.
  await insertMessageBasis(tx, { messageId: kickoffId, organizationId: run.organizationId, basis: run.sourceScopes })
  await insertMessageDisclosureSources(tx, {
    messageId: kickoffId,
    organizationId: run.organizationId,
    sources: run.disclosureSources,
  })

  const actorContext = buildAgentActorContext({
    agentId: input.agentId,
    channelId: run.channelId,
    effectiveUserId: run.requestedByUserId,
    organizationId: run.organizationId,
    projectId: thread.channel.projectId,
    source: DEEP_WATER_DELIVERY_PURPOSE,
    teamId: run.teamId,
    threadId: run.threadId,
    uoaIdentity: run.uoaIdentity,
  })
  const principalUserId = run.principalUserId ?? undefined
  const claim = await claimThreadRunOrPend(tx, {
    agentId: input.agentId,
    ...(principalUserId ? { principalUserId } : {}),
    threadId: run.threadId,
    pending: { actorContext, channelId: run.channelId, interactive: false, messageId: kickoffId },
  })
  if (claim === 'claimed') {
    await startAgentRun(tx, {
      actorContext,
      agentId: input.agentId,
      channelId: run.channelId,
      messageId: kickoffId,
      organizationId: run.organizationId,
      ...(principalUserId ? { principalUserId } : {}),
      purpose: input.content,
      threadId: run.threadId,
    })
  }
  return { kind: claim, kickoffId }
}
