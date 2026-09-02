import type { PrismaClient } from '@prisma/client'
import {
  AGENT_EDIT_AUTHORITY_ERROR_CODES,
  AgentEditAuthorityError,
  assertAgentEditAuthority,
  type AgentEditActor,
} from '@nessie/workspace-admin'
import type { AgentRecord } from '../contracts.js'
import type { AgentAvatarBackgroundColor } from '@nessie/schemas'
import { mapAgentRecord } from './agents.js'

/**
 * An agent's portrait follows the same edit authority as the rest of its
 * configuration — the live owner of a private or person-owned agent, anyone
 * entitled to a team-owned one, plus organization owners. The actor is threaded
 * in rather than checked only at the route so the `agent_avatar_update` tool
 * cannot end up with a different rule.
 */
export const updateAgentAvatar = async (
  prisma: PrismaClient,
  agentId: string,
  actor: AgentEditActor,
  avatarAttachmentId: string | null,
  avatarBackgroundColor?: AgentAvatarBackgroundColor,
): Promise<AgentRecord | null> => {
  const existing = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      organizationId: true,
      ownerUserId: true,
      systemManaged: true,
      visibility: true,
    },
  })
  if (!existing) {
    return null
  }
  // Refused in the service, not merely hidden by the route: a blueprint-managed
  // agent's face is part of its blueprint.
  if (existing.systemManaged) {
    throw new AgentEditAuthorityError(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.SYSTEM_IMMUTABLE,
      'This agent is managed by Nessie itself and cannot be edited.',
    )
  }
  await assertAgentEditAuthority(prisma, actor, existing)

  const agent = await prisma.agent.update({
    where: { id: agentId },
    data: {
      avatarAttachmentId,
      ...(avatarBackgroundColor !== undefined ? { avatarBackgroundColor } : {}),
    },
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
