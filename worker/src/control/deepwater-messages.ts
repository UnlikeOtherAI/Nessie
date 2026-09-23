import type { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  computeReplyBasis,
  createMentionUserAlerts,
  isDeepWaterPersonBriefUnlaunched,
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
import {
  createSystemAuthoredMessage,
  createSystemAuthoredReply,
  ensureDefaultThread,
  personalAssistantDmKey,
} from '@nessie/team-admin'

import type { DeepWaterAnnouncements } from './deepwater-announce.js'

/**
 * The messages DeepWater writes into the thread a research belongs to: the
 * research card (Water plan amendments N1), and the results and notices
 * addressed to the person who asked (N3, N4, N5). Every one is written inside
 * the caller's transaction, stamped with the disclosure its run carries into
 * the thread it lands in (N6), placed under the card once there is one, and
 * announced through the caller's collector once that transaction commits. A
 * notice about a person's brief the room was never shown lands in the
 * requester's own Personal Assistant conversation instead.
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

type NoticeTarget = {
  channelId: string
  threadId: string
  /** The reply root it is posted under; null posts it at the top level. */
  rootMessageId: string | null
  basis: BasisScopeRow[]
}

/** The requester's own Personal Assistant conversation, read-only (as an approval card finds it). */
const requesterAssistantThread = async (
  tx: Tx,
  input: { organizationId: string; userId: string },
): Promise<{ channelId: string; threadId: string } | null> => {
  const channel = await tx.channel.findFirst({
    where: { dmKey: personalAssistantDmKey(input), organizationId: input.organizationId, deletedAt: null },
    select: { id: true },
  })
  return channel ? { channelId: channel.id, threadId: await ensureDefaultThread(tx, channel.id) } : null
}

/**
 * Where a notice about this run lands: under the card in the origin thread —
 * except for a person's brief that was never launched. That brief is theirs
 * alone (`isDeepWaterPersonBriefUnlaunched`, the viewer predicate's own fact,
 * read from the row so a launch earlier in this transaction counts), so a
 * notice about it goes where only they read: their Personal Assistant
 * conversation, unless the brief came from there. Posting it in a shared room,
 * even withheld, would tell everyone else that a private brief exists. Null
 * when there is nowhere to post it.
 */
const noticeTarget = async (tx: Tx, run: DeepWaterBriefRun, requester: string): Promise<NoticeTarget | null> => {
  const row = await tx.productIntegrationRun.findUnique({ where: { id: run.id }, select: { launchedAt: true } })
  if (isDeepWaterPersonBriefUnlaunched({ ...run, launchedAt: row?.launchedAt ?? null })) {
    const own = await requesterAssistantThread(tx, { organizationId: run.organizationId, userId: requester })
    if (!own) {
      // Every person who has signed in has this conversation; without it the
      // brief's own dialog is the only place left that may say what happened.
      console.error(`[deep-water] run ${run.id}: the requester has no Personal Assistant conversation to be told in`)
      return null
    }
    if (own.channelId !== run.channelId) {
      const destination = await loadDeepWaterOriginDestination(tx, {
        organizationId: run.organizationId,
        threadId: own.threadId,
      })
      if (!destination) return null
      return {
        channelId: own.channelId,
        threadId: own.threadId,
        rootMessageId: null,
        basis: computeReplyBasis(run.sourceScopes, destination.chain, destination.boundAgentIds),
      }
    }
  }
  if (!run.threadId) return null
  const thread = await deepWaterThreadBasis(tx, run)
  if (!thread) return null
  return {
    channelId: thread.channelId,
    threadId: run.threadId,
    rootMessageId: await deepWaterReplyRoot(tx, run),
    basis: thread.basis,
  }
}

/**
 * Post a result or notice addressed to the person who asked (`noticeTarget`:
 * under the card, or in their own conversation for a brief nobody else was
 * shown), stamped for the thread it lands in, with a durable alert keyed to the
 * run and kind so a replay never alerts twice, and a push to their devices.
 * Null when there is nowhere to post it.
 */
export const postDeepWaterNotice = async (
  tx: Tx,
  announce: DeepWaterAnnouncements,
  run: DeepWaterBriefRun,
  input: { kind: DeepWaterNoticeKind; content: string; alertKey?: string },
): Promise<{ messageId: string } | null> => {
  const requester = run.requestedByUserId
  if (!requester) return null
  const target = await noticeTarget(tx, run, requester)
  if (!target) return null
  const { basis, rootMessageId: root } = target
  const notice = {
    basisScopes: basis,
    content: input.content,
    disclosureSources: run.disclosureSources,
    followedByUserIds: [requester],
    metadata: DeepWaterNoticeMessageMetadataSchema.parse({
      deepWaterNotice: { schemaVersion: 1, runId: run.id, kind: input.kind },
    }) as Prisma.InputJsonValue,
    role: 'assistant' as const,
    threadId: target.threadId,
  }
  const posted = root
    ? await createSystemAuthoredReply(tx, { ...notice, authorId: null, rootMessageId: root })
    : { message: await createSystemAuthoredMessage(tx, notice), replyMetadata: null }
  const { message } = posted
  const eventKey = input.alertKey ?? `deep-water-${input.kind}:${run.id}`
  const alerted = await createMentionUserAlerts(tx, {
    organizationId: run.organizationId,
    messageId: message.id,
    threadId: target.threadId,
    channelId: target.channelId,
    actorUserId: null,
    actorAgentId: null,
    mentionedUserIds: [requester],
    eventKey,
  })
  const restricted = basis.length > 0 || run.disclosureSources.length > 0
  await enqueueNoticePush(tx, {
    run,
    messageId: message.id,
    channelId: target.channelId,
    threadId: target.threadId,
    rootMessageId: root,
    content: message.content,
    restricted,
    recipientUserIds: alerted,
  })
  announce.message({
    channelId: target.channelId,
    threadId: target.threadId,
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
    channelId: target.channelId,
    threadId: target.threadId,
    messageId: message.id,
    createdAt: message.createdAt,
    userIds: alerted,
    eventKey,
  })
  return { messageId: message.id }
}
