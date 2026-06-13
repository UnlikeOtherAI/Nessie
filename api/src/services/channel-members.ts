import type { PrismaClient } from '@prisma/client'
import { loadChannelTeamProject } from './channel-slugs.js'

export const addMemberToChannel = async (
  prisma: PrismaClient,
  channelId: string,
  userId: string,
): Promise<boolean> => {
  // Load the channel's org and confirm the target user belongs to it before
  // the upsert, so a cross-org user can never be added to a channel.
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { organizationId: true },
  })
  if (!channel) {
    return false
  }

  const isOrgMember = await prisma.organizationMember.count({
    where: { organizationId: channel.organizationId, userId },
  })
  if (!isOrgMember) {
    return false
  }

  await prisma.channelMember.upsert({
    where: { channelId_userId: { channelId, userId } },
    create: { channelId, userId },
    update: {},
  })
  return true
}

export const removeMemberFromChannel = async (
  prisma: PrismaClient,
  channelId: string,
  userId: string,
): Promise<void> => {
  await prisma.channelMember.deleteMany({
    where: { channelId, userId },
  })
}

export const validateTenantHierarchy = async (
  prisma: PrismaClient,
  organizationId: string,
  teamId: string,
): Promise<boolean> =>
  (await loadChannelTeamProject(prisma, { organizationId, teamId })) !== null
