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
export type AgentEntitlementScope = {
  includeSystemManaged?: boolean
  /** Organization owners reach every agent in the tenant, bound or not. */
  includeUnbound: boolean
  organizationId: string
  userId: string
}

/**
 * The entitlement half of the list, on its own.
 *
 * `readAgentRecordForActor` answers the same question about ONE agent, and a
 * second `where` beside this one would be exactly the fork Rule zero names —
 * the list and the detail read would start agreeing and quietly stop.
 */
export const buildAgentEntitlementWhere = (
  scope: AgentEntitlementScope,
): Prisma.AgentWhereInput => {
  const { includeSystemManaged = false, includeUnbound, organizationId, userId } = scope
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
    // System agents are a read-only tier, and they are app-provided — vendor
    // definitions holding no tenant secrets. Availability must not depend on a
    // binding accident: the channel-gated version of this arm made a global
    // agent whose per-user DM had not been provisioned yet (or whose binding
    // was bootstrapped for somebody else) invisible to everyone, which is
    // exactly the unreachable-capability defect. The row is listed; what a
    // caller may *do* with it is decided elsewhere.
    visibilityFilters.push({ organizationId, systemManaged: true })
  }

  return {
    AND: [buildAgentVisibilityWhere({ organizationId, userId })],
    organizationId,
    OR: visibilityFilters,
  }
}

/** The joins `mapAgentRecord` reads, scoped to channels the caller can see. */
export const agentEntitlementInclude = (scope: AgentEntitlementScope) => {
  const visibleChannelWhere = buildAccessibleChannelWhere({
    includeAllOrgChannels: scope.includeUnbound,
    organizationId: scope.organizationId,
    userId: scope.userId,
  })
  return {
    ownerMembership: AGENT_OWNER_MEMBERSHIP_SELECT,
    bindings: {
      where: { channel: visibleChannelWhere },
      orderBy: { createdAt: 'asc' },
      select: { channelId: true },
    },
    messages: {
      where: { thread: { channel: visibleChannelWhere } },
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
      where: { thread: { channel: visibleChannelWhere } },
      orderBy: { createdAt: 'desc' },
      take: 1,
    },
  } satisfies Prisma.AgentInclude
}

export const listAgentsForUser = async (
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  includeUnbound: boolean,
  includeSystemManaged = false,
): Promise<AgentRecord[]> => {
  const scope: AgentEntitlementScope = {
    includeSystemManaged,
    includeUnbound,
    organizationId,
    userId,
  }
  const agents = await prisma.agent.findMany({
    where: buildAgentEntitlementWhere(scope),
    include: agentEntitlementInclude(scope),
    orderBy: { createdAt: 'asc' },
  })

  return agents.map(mapAgentRecord)
}

/**
 * One agent, through exactly the list's entitlement. Returns null for an agent
 * the caller could not have seen in the list — indistinguishable from an agent
 * that does not exist, which is the refusal every per-agent route already makes.
 */
export const findEntitledAgent = async (
  prisma: PrismaClient,
  agentId: string,
  scope: AgentEntitlementScope,
): Promise<AgentRecord | null> => {
  const agent = await prisma.agent.findFirst({
    where: { ...buildAgentEntitlementWhere(scope), id: agentId },
    include: agentEntitlementInclude(scope),
  })
  return agent ? mapAgentRecord(agent) : null
}
