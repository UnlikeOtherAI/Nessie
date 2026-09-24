import type { Prisma, PrismaClient } from '@prisma/client'

import { rerenderTicketWorkKickoff } from '../../control/ticket-work-run.js'
import { resolveAgentTodoKickoffPrompt } from './todo-kickoff.js'
import type { RunContext } from './types.js'

/**
 * The prompt a run starts from, once it holds its claim: the trigger message's
 * own words, unless the message is a kickoff the platform rebuilds at the
 * start of the run that consumes it.
 *
 * - An agent-todo kickoff claims or materialises its items
 *   (`resolveAgentTodoKickoffPrompt`).
 * - A `ticket.work` kickoff is rendered again from its work record as it is
 *   now (`rerenderTicketWorkKickoff`, docs/standards/ticket-work.md → "What
 *   every wake says"): a wake that pended behind another run may drain after
 *   the ticket moved on, the work ended or parked, and its run is told that —
 *   never the state it was queued in.
 */
export const resolveRunKickoffPrompt = async (
  prisma: PrismaClient,
  context: RunContext,
  input: { messageId: string; metadata: Prisma.JsonValue | null; prompt: string },
): Promise<string> => {
  const prompt = await resolveAgentTodoKickoffPrompt(prisma, context, input)
  const ticketWork = await rerenderTicketWorkKickoff(prisma, {
    messageId: input.messageId,
    metadata: input.metadata,
    agentId: context.agent.id,
    threadId: context.run.threadId,
  })
  return ticketWork ?? prompt
}
