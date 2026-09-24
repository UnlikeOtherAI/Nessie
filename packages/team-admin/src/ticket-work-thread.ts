import type { Prisma, PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  CONVERSATION_TITLE_MAX_CHARS,
  TICKET_WORK_THREAD_EVENT_LABELS,
  TICKET_WORK_THREAD_MESSAGE_TOPIC,
  type TicketWorkThreadEvent,
  type TicketWorkThreadMessageJobPayload,
} from '@nessie/schemas'

import { canMemberEditProjectBoards } from './resource-authority.js'

/**
 * A ticket's work thread (docs/standards/ticket-work.md → "The work thread").
 *
 * There is one per (trigger, ticket): a conversation with the trigger's agent
 * in the trigger's target channel, titled after the ticket and carrying
 * `{ taskId, triggerId }` in its metadata. A ticket that comes back after its
 * work ended is worked in the same thread, so the whole story stays in one
 * place. Kept apart from `agent-conversations.ts`, which is a person's own
 * conversation list and is over the size cap.
 */

/** "ENG-12 Fix login redirect" for a mirrored ticket; the title alone for a native one, which has no key. */
export const ticketWorkThreadTitle = (task: {
  title: string | null
  externalLink?: { externalKey: string | null } | null
}): string => {
  const title = [task.externalLink?.externalKey, task.title ?? 'Untitled ticket']
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
  return title.length <= CONVERSATION_TITLE_MAX_CHARS
    ? title
    : `${title.slice(0, CONVERSATION_TITLE_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * The thread this trigger works this ticket in: the one an earlier record of
 * the same pair used, while it is still in the trigger's target channel, or a
 * new one there. Runs in the caller's transaction, beside the record it is for.
 */
export const ensureTicketWorkThread = async (
  tx: Pick<Prisma.TransactionClient, 'agentTicketWork' | 'thread'>,
  input: {
    triggerId: string
    taskId: string
    agentId: string
    channelId: string
    title: string
  },
): Promise<{ id: string; reused: boolean }> => {
  const earlier = await tx.agentTicketWork.findFirst({
    where: { triggerId: input.triggerId, taskId: input.taskId, thread: { channelId: input.channelId } },
    orderBy: { startedAt: 'desc' },
    select: { threadId: true },
  })
  if (earlier) return { id: earlier.threadId, reused: true }
  const thread = await tx.thread.create({
    data: {
      agentId: input.agentId,
      channelId: input.channelId,
      // Nobody opened it: the platform did, for the ticket.
      startedByUserId: null,
      title: input.title,
      metadata: { taskId: input.taskId, triggerId: input.triggerId },
    },
    select: { id: true },
  })
  return { id: thread.id, reused: false }
}

export type TicketWorkThread = {
  organizationId: string
  projectId: string
  taskId: string
}

/**
 * Whether a thread is a ticket's work thread, and whose: the newest work
 * record that names it. A thread keeps being one after its work ended, or its
 * trigger was deleted, so the posting rule below holds for its whole life.
 */
export const findTicketWorkThread = async (
  prisma: Pick<PrismaClient, 'agentTicketWork'>,
  threadId: string,
): Promise<TicketWorkThread | null> => prisma.agentTicketWork.findFirst({
  where: { threadId },
  orderBy: { startedAt: 'desc' },
  select: { organizationId: true, projectId: true, taskId: true },
})

/**
 * **Only people who can edit the ticket's board write in its work thread**,
 * asked live on every post: what they write steers the agent's work, so the
 * people who may steer it are exactly those who may start it. A REST caller
 * passes the request's verified organisation role (`isOrganizationAdmin`);
 * the worker's tools have none and read the membership row.
 */
export const canPostInTicketWorkThread = (
  prisma: PrismaClient,
  input: { thread: TicketWorkThread; userId: string; isOrganizationAdmin?: boolean },
): Promise<boolean> => canMemberEditProjectBoards(prisma, {
  organizationId: input.thread.organizationId,
  userId: input.userId,
  projectId: input.thread.projectId,
  ...(input.isOrganizationAdmin === undefined ? {} : { isOrganizationAdmin: input.isOrganizationAdmin }),
})

/**
 * The job that tells the worker a board editor wrote in a work thread
 * (`ticket-work.thread-message`), enqueued in the transaction that writes the
 * message — by the message route and by `send_message` alike — so a steer
 * never commits without the job that delivers it, and a message that rolled
 * back leaves no job behind.
 */
export const enqueueTicketWorkThreadMessage = async (
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  input: { organizationId: string; messageId: string },
): Promise<void> => {
  const payload: TicketWorkThreadMessageJobPayload = input
  await enqueueQueueJob(tx, {
    idempotencyKey: `${TICKET_WORK_THREAD_MESSAGE_TOPIC}:${input.messageId}`,
    payload,
    topic: TICKET_WORK_THREAD_MESSAGE_TOPIC,
  })
}

/** What a person who may not post there is told, and what the composer says. */
export const TICKET_WORK_THREAD_READ_ONLY_SENTENCE =
  'Only people who can edit this ticket\'s board write in its work thread. '
  + 'Comment on the ticket to give the agent more information.'

/**
 * One compact row in a work thread (`metadata.ticketWorkEvent`): why the
 * agent was woken, why the platform stopped it, or who cancelled its
 * reminder. Never ticket text: the channel can be wider than the ticket's
 * project.
 */
export const writeTicketWorkThreadRow = async (
  tx: Pick<Prisma.TransactionClient, 'message'>,
  input: { threadId: string; event: TicketWorkThreadEvent },
): Promise<void> => {
  await tx.message.create({
    data: {
      threadId: input.threadId,
      role: 'system',
      content: `${TICKET_WORK_THREAD_EVENT_LABELS[input.event.kind]}: ${input.event.summary}`,
      metadata: { ticketWorkEvent: input.event } as Prisma.InputJsonValue,
    },
  })
}
