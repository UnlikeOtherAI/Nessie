import type { PrismaClient } from '@prisma/client'
import type { AgentRecord } from '../contracts.js'
import { mapAgentRecord } from './agents.js'

export const updateAgentAvatar = async (
  prisma: PrismaClient,
  agentId: string,
  avatarAttachmentId: string | null,
): Promise<AgentRecord | null> => {
  const existing = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  })
  if (!existing) {
    return null
  }

  const agent = await prisma.agent.update({
    where: { id: agentId },
    data: { avatarAttachmentId },
    include: {
      bindings: {
        orderBy: { createdAt: 'asc' },
        select: { channelId: true },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
        take: 1,
      },
      runs: {
        include: {
          toolCalls: {
            orderBy: { startedAt: 'desc' },
            select: {
              endedAt: true,
              startedAt: true,
              toolName: true,
            },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  return mapAgentRecord(agent)
}
