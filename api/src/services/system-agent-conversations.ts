import type { PrismaClient } from '@prisma/client'
import {
  channelTeamInclude,
  isDmAddressableSystemAgent,
  mapChannelRecord,
} from '@nessie/workspace-admin'
import type { ChannelRecord } from '@nessie/schemas'

import { openGlobalAgentHome } from './global-agent-home.js'
import { ensurePersonalAssistantBootstrap } from './personal-assistant.js'

/**
 * Addressing a DM-homed system agent from "New message".
 *
 * The Direct-messages list shows *conversations*; the address book shows what
 * you can start one with, which includes the app's own agents. But a global
 * agent is never placed into a new channel — `bindAgentToChannel` refuses every
 * `systemManaged` agent and every system channel, and a system DM is
 * single-member by database constraint. It already has one home DM per person,
 * provisioned at login. So addressing it *resolves* to that channel, ensuring
 * it exists first through the one provisioning path each agent already owns:
 * `openGlobalAgentHome` (which calls `ensureGlobalAgentBootstrap`) for a global
 * agent, `ensurePersonalAssistantBootstrap` for the PA. There is deliberately
 * no second provisioning path here.
 *
 * The whole decision lives in this one function so the route stays a mapping
 * of outcomes to responses, and so the gate is exercised by tests against real
 * rows rather than by reading the route.
 */
export type SystemAgentConversationOutcome =
  /** No addressable system agent was named — the ordinary owner-gated path. */
  | { kind: 'none' }
  /** Named alongside other recipients: refused, in words. */
  | { kind: 'exclusive'; agentName: string }
  | { kind: 'channel'; channel: ChannelRecord }

type SystemAgentRow = {
  agentKind: string
  id: string
  name: string
  systemManaged: boolean
  systemSlug: string | null
}

/**
 * The system agents among `agentIds` that a person may address, scoped to the
 * caller's own organisation. An unknown id, another tenant's agent, or a system
 * agent with no per-person home is simply absent, and the caller falls through
 * to the ordinary path — which refuses it exactly as it did before.
 */
export const findAddressableSystemAgents = async (
  prisma: PrismaClient,
  input: { agentIds: string[]; organizationId: string },
): Promise<SystemAgentRow[]> => {
  const agentIds = Array.from(new Set(input.agentIds))
  if (agentIds.length === 0) {
    return []
  }
  const agents = await prisma.agent.findMany({
    where: {
      id: { in: agentIds },
      organizationId: input.organizationId,
      systemManaged: true,
    },
    select: {
      agentKind: true,
      id: true,
      name: true,
      systemManaged: true,
      systemSlug: true,
    },
  })
  return agents.filter((agent) => isDmAddressableSystemAgent(agent))
}

const openSystemAgentHome = async (
  prisma: PrismaClient,
  input: {
    agent: SystemAgentRow
    organizationId: string
    teamId: string
    userId: string
  },
): Promise<ChannelRecord | null> => {
  if (input.agent.systemSlug) {
    const home = await openGlobalAgentHome(prisma, {
      organizationId: input.organizationId,
      slug: input.agent.systemSlug,
      teamId: input.teamId,
      userId: input.userId,
    })
    return home?.channel ?? null
  }

  const bootstrap = await ensurePersonalAssistantBootstrap(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
    userId: input.userId,
  })
  const channel = await prisma.channel.findUniqueOrThrow({
    where: { id: bootstrap.channelId },
    include: channelTeamInclude,
  })
  return mapChannelRecord(prisma, channel, input.userId)
}

/**
 * Resolve a "New message" whose recipients name a DM-homed system agent.
 *
 * Member-level by construction: the owner gate on the ordinary path exists
 * because binding an arbitrary agent into a new conversation is *placement*,
 * and opening your own pre-provisioned home DM is not placement at all — it is
 * the same channel the sidebar already offers you.
 */
export const resolveSystemAgentConversation = async (
  prisma: PrismaClient,
  input: {
    agentIds: string[]
    organizationId: string
    teamId: string
    userId: string
    userIds: string[]
  },
): Promise<SystemAgentConversationOutcome> => {
  const addressable = await findAddressableSystemAgents(prisma, {
    agentIds: input.agentIds,
    organizationId: input.organizationId,
  })
  const agent = addressable[0]
  if (!agent) {
    return { kind: 'none' }
  }

  const otherAgentCount = new Set(input.agentIds).size - 1
  const otherUserIds = input.userIds.filter((userId) => userId !== input.userId)
  if (otherAgentCount > 0 || otherUserIds.length > 0) {
    return { agentName: agent.name, kind: 'exclusive' }
  }

  const channel = await openSystemAgentHome(prisma, {
    agent,
    organizationId: input.organizationId,
    teamId: input.teamId,
    userId: input.userId,
  })
  return channel ? { channel, kind: 'channel' } : { kind: 'none' }
}
