import type { PrismaClient } from '@prisma/client'
import { mentionedAgentIdsFromContent } from '@nessie/runtime'
import {
  parseChannelId,
  parseThreadId,
  type AgentRecord,
  type AuthorizedActionContext,
  type OrchestrateDecideJobPayload,
} from '@nessie/schemas'
import { enqueueOrchestrateDecide } from '../queue/pgqueue.js'

type AgentInviteReplyPrisma = Pick<PrismaClient, '$executeRaw' | 'message'>

type EnqueueOrchestration = (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: OrchestrateDecideJobPayload,
  idempotencyKey: string,
) => Promise<boolean>

export type InviteAgentMentionReplayInput = {
  actorContext: AuthorizedActionContext
  agent: AgentRecord
  channelId: string
  messageId: string
  organizationId: string
}

/**
 * Replay the exact user message that prompted an agent invitation. The agent
 * has only just become a channel member, so it could not be considered when
 * the message was first created. This keeps the security boundary intact: a
 * caller may replay only their own live message in this channel, and it must
 * structurally @mention the newly bound agent.
 */
export const enqueueInvitedAgentMentionReplay = async (
  prisma: AgentInviteReplyPrisma,
  input: InviteAgentMentionReplayInput,
  enqueue: EnqueueOrchestration = enqueueOrchestrateDecide,
): Promise<boolean> => {
  const message = await prisma.message.findFirst({
    where: {
      deletedAt: null,
      id: input.messageId,
      role: 'user',
      thread: {
        channelId: input.channelId,
        channel: { organizationId: input.organizationId },
      },
      userId: input.actorContext.actor.actorId,
    },
    select: { content: true, id: true, role: true, threadId: true },
  })
  if (!message || !mentionedAgentIdsFromContent(message.content, [input.agent]).includes(input.agent.id)) {
    return false
  }

  return enqueue(
    prisma,
    {
      actorContext: input.actorContext,
      channelAgents: [{
        id: input.agent.id,
        name: input.agent.name,
        role: input.agent.role,
        systemPrompt: input.agent.systemPrompt ?? null,
      }],
      channelId: parseChannelId(input.channelId),
      content: message.content,
      messageId: message.id,
      role: message.role,
      threadId: parseThreadId(message.threadId),
    },
    `orchestrate:invite:${message.id}:${input.agent.id}`,
  )
}
