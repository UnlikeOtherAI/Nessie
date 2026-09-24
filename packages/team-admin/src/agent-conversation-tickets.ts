import type { PrismaClient } from '@prisma/client'
import { ticketWorkThreadRefOf, type AgentConversationRecord } from '@nessie/schemas'

import { listAgentConversationRecordsForUser, loadConversationRecordForUser } from './agent-conversations.js'

/**
 * A person's conversations, each naming the ticket it works when it is a
 * ticket's work thread (`AgentConversationRecord.ticket`, from the thread's
 * own `{ taskId, triggerId }` metadata that `ensureTicketWorkThread` writes),
 * so the conversation list can fold ticket threads under Tickets
 * (docs/standards/ticket-work.md → "What the project sees").
 *
 * Kept apart from `agent-conversations.ts`, which is over the size cap: these
 * are its two reads, as every door calls them, with the ticket attached from
 * one more read of the threads already on the page.
 */

const withTicketRefs = async (
  prisma: PrismaClient,
  records: AgentConversationRecord[],
): Promise<AgentConversationRecord[]> => {
  if (records.length === 0) return records
  const threads = await prisma.thread.findMany({
    where: { id: { in: records.map((record) => record.id) } },
    select: { id: true, metadata: true },
  })
  const refs = new Map(threads.map((thread) => [thread.id, ticketWorkThreadRefOf(thread.metadata)]))
  return records.map((record) => ({ ...record, ticket: refs.get(record.id) ?? null }))
}

/** One conversation, by thread (`loadConversationRecordForUser`), naming its ticket. */
export const loadConversationForUser = async (
  prisma: PrismaClient,
  input: Parameters<typeof loadConversationRecordForUser>[1],
): Promise<AgentConversationRecord | null> => {
  const record = await loadConversationRecordForUser(prisma, input)
  return record ? (await withTicketRefs(prisma, [record]))[0] ?? null : null
}

/** An agent's conversations (`listAgentConversationRecordsForUser`), each naming its ticket. */
export const listAgentConversationsForUser = async (
  prisma: PrismaClient,
  input: Parameters<typeof listAgentConversationRecordsForUser>[1],
): ReturnType<typeof listAgentConversationRecordsForUser> => {
  const page = await listAgentConversationRecordsForUser(prisma, input)
  return page ? { ...page, data: await withTicketRefs(prisma, page.data) } : null
}
