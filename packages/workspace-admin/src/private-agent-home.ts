import type { Prisma, PrismaClient } from '@prisma/client'
import { parseChannelId } from '@nessie/schemas'

import { ensureDefaultThread } from './channel-records.js'

type TransactionClient = PrismaClient | Prisma.TransactionClient

export const privateAgentHomeDmKey = (input: {
  agentId: string
  organizationId: string
  ownerUserId: string
}): string => `agent:${input.organizationId}:${input.ownerUserId}:${input.agentId}`

export const ensurePrivateAgentHome = async (
  prisma: TransactionClient,
  input: {
    agentId: string
    label: string
    organizationId: string
    ownerUserId: string
    teamId: string | undefined
  },
): Promise<string> => {
  if (!input.teamId) {
    throw new Error('PRIVATE_AGENT_HOME_TEAM_REQUIRED')
  }

  const team = await prisma.team.findFirst({
    where: { id: input.teamId, project: { organizationId: input.organizationId } },
    select: { projectId: true },
  })
  if (!team) {
    throw new Error('PRIVATE_AGENT_HOME_TEAM_NOT_FOUND')
  }

  const dmKey = privateAgentHomeDmKey(input)
  const channel = await prisma.channel.upsert({
    where: { dmKey },
    create: {
      dmKey,
      label: input.label,
      organizationId: input.organizationId,
      projectId: team.projectId,
      teamId: input.teamId,
      type: 'dm',
      visibility: 'private',
      members: { create: { userId: input.ownerUserId } },
    },
    update: {
      label: input.label,
      organizationId: input.organizationId,
      projectId: team.projectId,
      teamId: input.teamId,
      type: 'dm',
      visibility: 'private',
      systemChannelType: null,
    },
    select: { id: true },
  })

  await prisma.channelMember.upsert({
    where: { channelId_userId: { channelId: channel.id, userId: input.ownerUserId } },
    create: { channelId: channel.id, userId: input.ownerUserId },
    update: {},
  })
  await prisma.channelMember.deleteMany({
    where: { channelId: channel.id, userId: { not: input.ownerUserId } },
  })
  await ensureDefaultThread(prisma, channel.id)

  // Home bindings are the one structural exception to `bindAgentToChannel`:
  // the migration trigger independently proves this exact DM belongs to this
  // exact private agent and owner before accepting the row.
  await prisma.agentBinding.upsert({
    where: { agentId_channelId: { agentId: input.agentId, channelId: channel.id } },
    create: { agentId: input.agentId, channelId: channel.id },
    update: {},
  })

  return parseChannelId(channel.id)
}
