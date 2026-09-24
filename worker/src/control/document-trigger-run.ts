import type { Prisma } from '@prisma/client'
import { DocumentTriggerThreadMetadataSchema, type DocumentTriggerThreadMetadata } from '@nessie/schemas'

import { buildAgentActorContext, startAgentRun } from './agent-run-start.js'
import { writeTicketWorkThreadRow } from './ticket-work-run.js'
import { claimThreadRunOrPend } from '../run/thread-serialization.js'

/**
 * A document change that belongs to no live ticket work, reviewed in the
 * document's own thread (docs/standards/document-triggers.md → "Where a
 * change lands"): one thread per (trigger, page) in the trigger's target
 * channel — a conversation with the trigger's agent, opened by nobody, with
 * metadata `{ pageId, triggerId }` — never the channel's General thread. The
 * run acts as the agent with no effective user and `interactive: false`, the
 * way every event trigger runs, so a document review never borrows a
 * person's reach. Called inside the delivery's transaction.
 */

export const DOCUMENT_TRIGGER_RUN_SOURCE = 'document_changed'

const metadataOf = (value: Prisma.JsonValue | null): DocumentTriggerThreadMetadata | null => {
  const parsed = DocumentTriggerThreadMetadataSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * The page's review thread for this trigger: the one an earlier change used,
 * while it is still the agent's conversation in the target channel, or a new one.
 */
export const ensureDocumentReviewThread = async (
  tx: Pick<Prisma.TransactionClient, 'thread'>,
  input: { triggerId: string; pageId: string; agentId: string; channelId: string; title: string },
): Promise<{ id: string; reused: boolean }> => {
  const candidates = await tx.thread.findMany({
    where: {
      channelId: input.channelId,
      agentId: input.agentId,
      metadata: { path: ['pageId'], equals: input.pageId },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, metadata: true, title: true },
  })
  const earlier = candidates.find((thread) => metadataOf(thread.metadata)?.triggerId === input.triggerId)
  if (earlier) {
    // Renamed, or no longer readable by the whole channel: the title follows.
    if (earlier.title !== input.title) {
      await tx.thread.update({ where: { id: earlier.id }, data: { title: input.title } })
    }
    return { id: earlier.id, reused: true }
  }
  const metadata: DocumentTriggerThreadMetadata = { pageId: input.pageId, triggerId: input.triggerId }
  const thread = await tx.thread.create({
    data: {
      agentId: input.agentId,
      channelId: input.channelId,
      startedByUserId: null,
      title: input.title,
      metadata,
    },
    select: { id: true },
  })
  return { id: thread.id, reused: false }
}

export const queueDocumentReviewRun = async (
  tx: Prisma.TransactionClient,
  input: {
    trigger: { id: string; agentId: string; organizationId: string }
    channel: { id: string; projectId: string; teamId: string }
    threadId: string
    kickoff: string
    /** The thread row's words: never the document's, never its title unless the channel may read it. */
    summary: string
    purpose: string
    deliveryId: string
  },
): Promise<{ kind: 'started' | 'pended'; messageId: string }> => {
  await writeTicketWorkThreadRow(tx, {
    threadId: input.threadId,
    event: { kind: 'document_woken', triggerId: input.trigger.id, reason: 'document_changed', summary: input.summary },
  })
  const kickoff = await tx.message.create({
    data: { threadId: input.threadId, role: 'system', content: input.kickoff },
    select: { id: true },
  })
  // As the agent, and never as a person: not the editor, not the trigger's author.
  const actorContext = buildAgentActorContext({
    agentId: input.trigger.agentId,
    channelId: input.channel.id,
    effectiveUserId: null,
    organizationId: input.trigger.organizationId,
    projectId: input.channel.projectId,
    source: DOCUMENT_TRIGGER_RUN_SOURCE,
    teamId: input.channel.teamId,
    threadId: input.threadId,
  })
  const claim = await claimThreadRunOrPend(tx, {
    agentId: input.trigger.agentId,
    threadId: input.threadId,
    pending: {
      actorContext,
      channelId: input.channel.id,
      interactive: false,
      messageId: kickoff.id,
      replyPlacement: 'channel',
      triggerId: input.trigger.id,
      triggerDeliveryId: input.deliveryId,
    },
  })
  if (claim === 'claimed') {
    await startAgentRun(tx, {
      actorContext,
      agentId: input.trigger.agentId,
      channelId: input.channel.id,
      messageId: kickoff.id,
      organizationId: input.trigger.organizationId,
      purpose: input.purpose,
      threadId: input.threadId,
      triggerDeliveryId: input.deliveryId,
      triggerId: input.trigger.id,
    })
  }
  return { kind: claim === 'claimed' ? 'started' : 'pended', messageId: kickoff.id }
}
