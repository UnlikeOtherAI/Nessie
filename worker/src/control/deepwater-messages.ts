import type { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
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
  PushDispatchJobPayloadSchema,
  ResearchRunRefMessageMetadataSchema,
  type DeepWaterNoticeKind,
} from '@nessie/schemas'
import { createSystemAuthoredMessage, createSystemAuthoredReply } from '@nessie/team-admin'

import type { DeepWaterAnnouncements } from './deepwater-announce.js'

/**
 * The messages DeepWater writes into the thread a research belongs to: the
 * research card (Water plan amendments N1), and the results and notices
 * addressed to the person who asked (N3, N4, N5). Every one is written inside
 * the caller's transaction, stamped with the disclosure its run carries into
 * that thread (N6), placed under the card once there is one, and announced
 * through the caller's collector once that transaction commits.
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
  announce: DeepWaterAnnouncements,
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
  const posted = root
    ? await createSystemAuthoredReply(tx, {
        ...card,
        authorId: agentAuthored ? run.originAgentId : run.requestedByUserId,
        rootMessageId: root,
      })
    : { message: await createSystemAuthoredMessage(tx, card), replyMetadata: null }
  const { message } = posted
  await tx.productIntegrationRun.update({ where: { id: run.id }, data: { messageId: message.id } })
  announce.message({
    channelId: thread.channelId,
    threadId: run.threadId,
    id: message.id,
    content: message.content,
    role: agentAuthored ? 'assistant' : 'user',
    agentId: agentAuthored ? run.originAgentId : null,
    userId: agentAuthored ? null : run.requestedByUserId,
    createdAt: message.createdAt,
    restricted: thread.basis.length > 0 || run.disclosureSources.length > 0,
    reply: root && posted.replyMetadata ? { rootMessageId: root, ...posted.replyMetadata } : null,
  })
  announce.run({ ...run, cardMessageId: message.id })
  return { messageId: message.id, created: true }
}

/** A notice as a lock screen shows it: its words, without markdown link targets. */
const pushSnippet = (content: string): string =>
  content.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 140)

/**
 * Ring the person a notice is addressed to (amendments N3 B.4), queued in the
 * notice's own transaction so neither commits alone. The dispatcher rechecks
 * their access, preferences and devices; a notice built from sources the room
 * does not imply says only that something is ready.
 */
const enqueueNoticePush = async (
  tx: Tx,
  input: {
    run: DeepWaterBriefRun
    messageId: string
    channelId: string
    threadId: string
    rootMessageId: string | null
    content: string
    restricted: boolean
    recipientUserIds: string[]
  },
): Promise<void> => {
  if (input.recipientUserIds.length === 0) return
  await enqueueQueueJob(tx, {
    idempotencyKey: `push:${input.messageId}`,
    payload: PushDispatchJobPayloadSchema.parse({
      authorName: 'DeepWater',
      channelId: input.channelId,
      contentSnippet: pushSnippet(input.content),
      ...(input.restricted ? { contentVisibility: 'generic' } : {}),
      mentionUserIds: input.recipientUserIds,
      messageId: input.messageId,
      organizationId: input.run.organizationId,
      recipientUserIds: input.recipientUserIds,
      ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
      threadId: input.threadId,
    }),
    topic: 'push.dispatch',
  })
}

/**
 * Has the room never been shown this person's brief? A person's brief is
 * theirs alone until they launch it — nobody else may see it
 * (`isDeepWaterRunVisible`), and the room first learns of it from the card
 * posted at Start. Read from the row, not the caller's copy, so a card posted
 * earlier in this transaction counts.
 */
const isUnannouncedPersonBrief = async (tx: Tx, run: DeepWaterBriefRun): Promise<boolean> => {
  if (run.originKind !== 'person') return false
  const row = await tx.productIntegrationRun.findUnique({ where: { id: run.id }, select: { messageId: true } })
  return !row?.messageId
}

/**
 * Post a result or notice addressed to the person who asked, under the card,
 * stamped for the thread, with a durable alert keyed to the run and kind so a
 * replay never alerts twice, and a push to their devices. Null when the origin
 * thread is gone.
 *
 * A notice about a person's brief the room was never shown (DeepWater never
 * confirmed it, or refused it before launch) also carries the requester's own
 * `user` scope, which only they satisfy: they are told in the conversation
 * they asked from, and everyone else sees the withheld placeholder rather than
 * the topic of a brief they may not see.
 */
export const postDeepWaterNotice = async (
  tx: Tx,
  announce: DeepWaterAnnouncements,
  run: DeepWaterBriefRun,
  input: { kind: DeepWaterNoticeKind; content: string; alertKey?: string },
): Promise<{ messageId: string } | null> => {
  const requester = run.requestedByUserId
  if (!run.threadId || !requester) return null
  const thread = await deepWaterThreadBasis(tx, run)
  if (!thread) return null
  const basis = await isUnannouncedPersonBrief(tx, run)
    ? [...thread.basis, { scopeType: 'user', scopeId: requester }]
    : thread.basis
  const root = await deepWaterReplyRoot(tx, run)
  const notice = {
    basisScopes: basis,
    content: input.content,
    disclosureSources: run.disclosureSources,
    followedByUserIds: [requester],
    metadata: DeepWaterNoticeMessageMetadataSchema.parse({
      deepWaterNotice: { schemaVersion: 1, runId: run.id, kind: input.kind },
    }) as Prisma.InputJsonValue,
    role: 'assistant' as const,
    threadId: run.threadId,
  }
  const posted = root
    ? await createSystemAuthoredReply(tx, { ...notice, authorId: null, rootMessageId: root })
    : { message: await createSystemAuthoredMessage(tx, notice), replyMetadata: null }
  const { message } = posted
  const eventKey = input.alertKey ?? `deep-water-${input.kind}:${run.id}`
  const alerted = await createMentionUserAlerts(tx, {
    organizationId: run.organizationId,
    messageId: message.id,
    threadId: run.threadId,
    channelId: thread.channelId,
    actorUserId: null,
    actorAgentId: null,
    mentionedUserIds: [requester],
    eventKey,
  })
  const restricted = basis.length > 0 || run.disclosureSources.length > 0
  await enqueueNoticePush(tx, {
    run,
    messageId: message.id,
    channelId: thread.channelId,
    threadId: run.threadId,
    rootMessageId: root,
    content: message.content,
    restricted,
    recipientUserIds: alerted,
  })
  announce.message({
    channelId: thread.channelId,
    threadId: run.threadId,
    id: message.id,
    content: message.content,
    role: 'assistant',
    agentId: null,
    userId: null,
    createdAt: message.createdAt,
    restricted,
    reply: root && posted.replyMetadata ? { rootMessageId: root, ...posted.replyMetadata } : null,
  })
  announce.alert({
    channelId: thread.channelId,
    threadId: run.threadId,
    messageId: message.id,
    createdAt: message.createdAt,
    userIds: alerted,
    eventKey,
  })
  return { messageId: message.id }
}
