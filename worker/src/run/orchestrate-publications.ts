import { type PgRealtimeTransport } from '@nessie/runtime'
import {
  parseAgentId,
  parseThreadId,
  parseUserId,
  type WsScope,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import type { ChannelAgent } from './orchestrate-candidates.js'

type AcknowledgementDecision = {
  action: 'acknowledge'
  agentId: string
  emoji: string
}

type CreatedRun = {
  agentId: string
  id: string
  threadId: string
}

export const publishReplyRunStarted = async ({
  channelId,
  content,
  isPersonalAssistantChannel,
  messageId,
  realtimeTransport,
  role,
  run,
  scopes,
}: {
  channelId: string
  content: string
  isPersonalAssistantChannel: boolean
  messageId: string
  realtimeTransport: PgRealtimeTransport
  role: string
  run: CreatedRun
  scopes: WsScope[]
}): Promise<void> => {
  const publishScopes = isPersonalAssistantChannel
    ? scopes
    : [...scopes, { kind: 'agent' as const, agentId: parseAgentId(run.agentId) }]

  await realtimeTransport.publishWs(publishScopes, {
    data: {
      agentId: parseAgentId(run.agentId),
      channelId,
      contentPreview: content.slice(0, 200),
      messageId,
      role,
      threadId: parseThreadId(run.threadId),
    },
    event: 'message.new',
  })
}

export const acknowledgeDecision = async ({
  candidate,
  decision,
  messageId,
  prisma,
  realtimeTransport,
  scopes,
  threadId,
}: {
  candidate: ChannelAgent
  decision: AcknowledgementDecision
  messageId: string
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
  scopes: WsScope[]
  threadId: string
}): Promise<void> => {
  await prisma.messageReaction.createMany({
    data: [{
      messageId,
      agentId: decision.agentId,
      onBehalfOfUserId: candidate.principalUserId ?? null,
      emoji: decision.emoji,
    }],
    skipDuplicates: true,
  })

  const reactionData = {
    messageId,
    agentId: parseAgentId(decision.agentId),
    ...(candidate.principalUserId
      ? { onBehalfOfUserId: parseUserId(candidate.principalUserId) }
      : {}),
    emoji: decision.emoji,
  }

  await realtimeTransport.publishSse(threadId, 'message.reaction', reactionData)
  await realtimeTransport.publishWs(scopes, {
    data: reactionData,
    event: 'message.reaction',
  })
}

export const logReplyDecision = (
  messageId: string,
  run: CreatedRun,
  taskId: string,
  threadId: string,
): void => {
  console.log(
    JSON.stringify({
      event: 'orchestrate.reply',
      agentId: run.agentId,
      runId: run.id,
      taskId,
      messageId,
      threadId,
    }),
  )
}
