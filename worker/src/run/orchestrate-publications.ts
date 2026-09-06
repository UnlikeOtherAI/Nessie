import { publishMessageEnvelope, type PgRealtimeTransport } from '@nessie/runtime'
import {
  parseAgentId,
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
  isSingleAgentSystemDm,
  messageId,
  realtimeTransport,
  role,
  run,
  scopes,
}: {
  channelId: string
  content: string
  isSingleAgentSystemDm: boolean
  messageId: string
  realtimeTransport: PgRealtimeTransport
  role: string
  run: CreatedRun
  scopes: WsScope[]
}): Promise<void> => {
  // A single-agent system DM (the PA's, a global agent's home) is private to
  // one person. The org-wide `agent` scope would broadcast its preview to every
  // subscriber of that agent — and a global agent's subscribers are the whole
  // organisation — so those DMs publish to their channel scope alone.
  const publishScopes = isSingleAgentSystemDm
    ? scopes
    : [...scopes, { kind: 'agent' as const, agentId: parseAgentId(run.agentId) }]

  await publishMessageEnvelope(realtimeTransport, publishScopes, {
    channelId,
    message: { agentId: run.agentId, content, id: messageId, role },
    threadId: run.threadId,
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
