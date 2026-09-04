import type { PrismaClient } from '@prisma/client'
import { mentionedAgentIdsFromContent } from '@nessie/runtime'
import {
  AgentMentionSchema,
  parseChannelId,
  parseThreadId,
  type AgentRecord,
  type AuthorizedActionContext,
  type OrchestrateDecideJobPayload,
} from '@nessie/schemas'
import { enqueueOrchestrateDecide } from '../queue/pgqueue.js'

// `channel` is here because the enqueue chokepoint resolves the destination's
// system-DM kind itself rather than trusting each wake path to pass it.
type AgentInviteReplyPrisma = Pick<PrismaClient, '$executeRaw' | 'channel' | 'message'>

type EnqueueOrchestration = (
  prisma: Pick<PrismaClient, '$executeRaw' | 'channel'>,
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
    select: { content: true, id: true, metadata: true, role: true, threadId: true },
  })
  if (!message) {
    return false
  }
  const metadata = message.metadata
  const mentions = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as { mentions?: unknown }).mentions
    : undefined
  const mentionRecord = mentions && typeof mentions === 'object' && !Array.isArray(mentions)
    ? mentions as { agentMentions?: unknown }
    : undefined
  const parsedMentions = AgentMentionSchema.array().safeParse(mentionRecord?.agentMentions)
  const hasStructuredMentionField = mentionRecord !== undefined
    && Object.hasOwn(mentionRecord, 'agentMentions')
  const mentionsInvitedAgent = hasStructuredMentionField
    ? parsedMentions.success && parsedMentions.data.some(
        (mention) => mention.agentId === input.agent.id && !mention.principalUserId,
      )
    : mentionedAgentIdsFromContent(message.content, [input.agent]).includes(input.agent.id)
  if (!mentionsInvitedAgent) {
    return false
  }

  return enqueue(
    prisma,
    {
      actorContext: input.actorContext,
      agentMentions: [{ agentId: input.agent.id, type: 'agent' }],
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
