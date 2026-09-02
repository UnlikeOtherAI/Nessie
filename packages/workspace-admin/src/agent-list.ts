import { Prisma, type PrismaClient } from '@prisma/client'
import { buildAgentVisibilityWhere, buildVisibleAgentWhere } from '@nessie/db'
import type { AgentRecord } from '@nessie/schemas'

import {
  AGENT_OWNER_MEMBERSHIP_SELECT,
  buildAccessibleChannelWhere,
  mapAgentRecord,
} from './agent-record.js'

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
 *
 * `includeSystemManaged` opts the Agents page into the read-only system tier
 * (the Personal Assistant and other `systemManaged` agents) so it can group
 * them under Personal / Global tabs. It is off by default, keeping the shape
 * every other caller — the `agent_list` tool included — already relies on. The
 * same channel-visibility filter still applies, so a member sees a system
 * agent only through a channel it can already reach (e.g. their own PA DM).
 */
export const listAgentsForUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  includeUnbound: boolean,
  includeSystemManaged = false,
): Promise<AgentRecord[]> => {
  const visibleChannelWhere = buildAccessibleChannelWhere({
    includeAllOrgChannels: includeUnbound,
    organizationId,
    userId,
  })
  const visibilityFilters: Prisma.AgentWhereInput[] = [
    buildVisibleAgentWhere({ organizationId, userId }),
  ]

  if (includeUnbound) {
    // Organization owners deliberately widen the ordinary entitlement to every
    // agent in the tenant, including private-channel and unbound agents. This
    // remains an additional route-only arm, not part of the shared member rule.
    visibilityFilters.push(
      { systemManaged: false, bindings: { some: { channel: { organizationId } } } },
      { systemManaged: false, bindings: { none: {} } },
    )
  }
  if (includeSystemManaged) {
    // System agents are a read-only Agents-page tier, and they are app-provided
    // — vendor definitions holding no tenant secrets. Availability must not
    // depend on a binding accident: the channel-gated version of this arm made
    // a global agent whose per-user DM had not been provisioned yet (or whose
    // binding was bootstrapped for somebody else) invisible to everyone, which
    // is exactly the unreachable-capability defect. The row is listed; what a
    // caller may *do* with it is decided elsewhere, and per-agent reads still
    // 404 on system agents.
    visibilityFilters.push({ organizationId, systemManaged: true })
  }

  const agents = await prisma.agent.findMany({
    where: {
      AND: [buildAgentVisibilityWhere({ organizationId, userId })],
      organizationId,
      OR: visibilityFilters,
    },
    include: {
      ownerMembership: AGENT_OWNER_MEMBERSHIP_SELECT,
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
