import type { Prisma } from '@prisma/client'
import {
  computeReplyBasis,
  createMentionUserAlerts,
  loadDeepWaterOriginDestination,
  lockDeepWaterBriefRun,
  type BasisScopeRow,
  type DeepWaterBriefRun,
} from '@nessie/runtime'
import {
  DeepWaterNoticeMessageMetadataSchema,
  ResearchRunRefMessageMetadataSchema,
  type DeepWaterNoticeKind,
} from '@nessie/schemas'
import { createSystemAuthoredMessage, createSystemAuthoredReply } from '@nessie/team-admin'

/**
 * The messages DeepWater writes into the thread a research belongs to: the
 * research card (Water plan amendments N1), and the results and notices
 * addressed to the person who asked (N3, N4, N5). Every one is written inside
 * the caller's transaction, stamped with the disclosure its run carries into
 * that thread (N6), and placed under the card once there is one.
 */

type Tx = Prisma.TransactionClient

/** What the research is about, as the person asked it. */
export const deepWaterTopic = (run: DeepWaterBriefRun): string => run.title ?? run.input?.topic ?? run.queryPreview

/** A short, quoted topic for a sentence. */
export const deepWaterTopicPreview = (run: DeepWaterBriefRun): string => {
  const topic = deepWaterTopic(run).replace(/\s+/g, ' ').trim()
  return topic.length > 120 ? `${topic.slice(0, 117)}…` : topic
}

/** The reply thread the run's own origin was already in, if any. */
const originRootMessageId = async (tx: Tx, run: DeepWaterBriefRun): Promise<string | null> => {
  if (run.originKind === 'person') return run.input?.originRootMessageId ?? null
  if (!run.originRunId) return null
  const origin = await tx.run.findUnique({ where: { id: run.originRunId }, select: { replyRootMessageId: true } })
  return origin?.replyRootMessageId ?? null
}

/**
 * Where a message about this run lands: under its research card once there is
 * one (the card's own root when the card is itself a reply), otherwise where
 * the request came from.
 */
export const deepWaterReplyRoot = async (tx: Tx, run: DeepWaterBriefRun): Promise<string | null> => {
  if (run.cardMessageId && run.threadId) {
    const card = await tx.message.findFirst({
      where: { id: run.cardMessageId, threadId: run.threadId, deletedAt: null },
      select: { id: true, rootMessageId: true },
    })
    if (card) return card.rootMessageId ?? card.id
  }
  return originRootMessageId(tx, run)
}

/**
 * The basis a message about this run carries into its origin thread: the
 * run's consumed sources the room does not already imply. Null when the thread
 * or its channel is gone, so nothing can be posted there.
 */
export const deepWaterThreadBasis = async (
  tx: Tx,
  run: DeepWaterBriefRun,
): Promise<{ basis: BasisScopeRow[]; channelId: string } | null> => {
  const destination = await loadDeepWaterOriginDestination(tx, {
    organizationId: run.organizationId,
    threadId: run.threadId,
  })
  if (!destination) return null
  return {
    basis: computeReplyBasis(run.sourceScopes, destination.chain, destination.boundAgentIds),
    channelId: destination.chain.channelId,
  }
}

/**
 * Post the research card once: the agent's own message for a brief it opened,
 * or the person's topic for a brief they started. Decided under the run's row
 * lock, so the ack, the watch and a replay post one card between them. Null
 * when the origin thread is gone.
 */
export const ensureDeepWaterResearchCard = async (
  tx: Tx,
  input: { organizationId: string; runId: string },
): Promise<{ messageId: string; created: boolean } | null> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  if (!locked) return null
  const { run } = locked
  if (run.cardMessageId) return { messageId: run.cardMessageId, created: false }
  if (!run.threadId || !run.requestedByUserId) return null
  const thread = await deepWaterThreadBasis(tx, run)
  if (!thread) return null
  const root = await originRootMessageId(tx, run)
  const agentAuthored = run.originKind === 'agent' && run.originAgentId !== null
  const card = {
    basisScopes: thread.basis,
    content: `DeepWater research: ${deepWaterTopic(run)}`,
    disclosureSources: run.disclosureSources,
    followedByUserIds: [run.requestedByUserId],
    metadata: ResearchRunRefMessageMetadataSchema.parse({
      researchRunRef: { schemaVersion: 1, runId: run.id },
    }) as Prisma.InputJsonValue,
    threadId: run.threadId,
    ...(agentAuthored
      ? { agentId: run.originAgentId, onBehalfOfUserId: run.principalUserId, role: 'assistant' as const }
      : { role: 'user' as const, userId: run.requestedByUserId }),
  }
  const message = root
    ? (await createSystemAuthoredReply(tx, {
        ...card,
        authorId: agentAuthored ? run.originAgentId : run.requestedByUserId,
        rootMessageId: root,
      })).message
    : await createSystemAuthoredMessage(tx, card)
  await tx.productIntegrationRun.update({ where: { id: run.id }, data: { messageId: message.id } })
  return { messageId: message.id, created: true }
}

/**
 * Post a result or notice addressed to the person who asked, under the card,
 * stamped for the thread, with a durable alert keyed to the run and kind so a
 * replay never alerts twice. Null when the origin thread is gone.
 */
export const postDeepWaterNotice = async (
  tx: Tx,
  run: DeepWaterBriefRun,
  input: { kind: DeepWaterNoticeKind; content: string; alertKey?: string },
): Promise<{ messageId: string } | null> => {
  if (!run.threadId || !run.requestedByUserId) return null
  const thread = await deepWaterThreadBasis(tx, run)
  if (!thread) return null
  const root = await deepWaterReplyRoot(tx, run)
  const notice = {
    basisScopes: thread.basis,
    content: input.content,
    disclosureSources: run.disclosureSources,
    followedByUserIds: [run.requestedByUserId],
    metadata: DeepWaterNoticeMessageMetadataSchema.parse({
      deepWaterNotice: { schemaVersion: 1, runId: run.id, kind: input.kind },
    }) as Prisma.InputJsonValue,
    role: 'assistant' as const,
    threadId: run.threadId,
  }
  const message = root
    ? (await createSystemAuthoredReply(tx, { ...notice, authorId: null, rootMessageId: root })).message
    : await createSystemAuthoredMessage(tx, notice)
  await createMentionUserAlerts(tx, {
    organizationId: run.organizationId,
    messageId: message.id,
    threadId: run.threadId,
    channelId: thread.channelId,
    actorUserId: null,
    actorAgentId: null,
    mentionedUserIds: [run.requestedByUserId],
    eventKey: input.alertKey ?? `deep-water-${input.kind}:${run.id}`,
  })
  return { messageId: message.id }
}
