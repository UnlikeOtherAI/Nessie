import { Prisma, type PrismaClient } from '@prisma/client'
import type { AgentRecord } from '@nessie/schemas'

import { buildAccessibleChannelWhere, mapAgentRecord } from './agent-record.js'

/**
 * The agents a person is entitled to see, as `GET /api/agents` answers it and
 * as the Agents page lists them.
 *
 * Entitlement, never ambient context: an owner reaches every non-system agent
 * in the organization including unbound ones, everybody else reaches an agent
 * through a channel they can see it working in (public, or one they belong to).
 * Nothing here narrows by the caller's project/team.
 *
 * Shared with the assistant's `agent_list` tool, which is how it resolves the
 * `agentId` that `agent_bind_channel` / `agent_trigger_create` demand — the
 * same list the owner picks from in the UI, so the two can never disagree.
 */
export const listAgentsForUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  includeUnbound: boolean,
): Promise<AgentRecord[]> => {
  const visibleChannelWhere = buildAccessibleChannelWhere({
    includeAllOrgChannels: includeUnbound,
    organizationId,
    userId,
  })
  const visibilityFilters: Prisma.AgentWhereInput[] = [
    {
      bindings: {
        some: {
          channel: visibleChannelWhere,
        },
      },
    },
  ]

  if (includeUnbound) {
    visibilityFilters.push({
      bindings: {
        none: {},
      },
    })
  }

  const agents = await prisma.agent.findMany({
    where: {
      organizationId,
      systemManaged: false,
      OR: visibilityFilters,
    },
    include: {
      bindings: {
        where: {
          channel: visibleChannelWhere,
        },
        orderBy: { createdAt: 'asc' },
        select: { channelId: true },
      },
      messages: {
        where: {
          thread: {
            channel: visibleChannelWhere,
          },
        },
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
        where: {
          thread: {
            channel: visibleChannelWhere,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return agents.map(mapAgentRecord)
}
