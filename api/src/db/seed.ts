import { randomUUID } from 'node:crypto'
import type { PrismaClient, User } from '@prisma/client'
import { parseUserId } from '@nessie/schemas'
import { createBootstrapSeedPlan, type BootstrapUserSeedInput } from './bootstrap.js'

export type BootstrapSeedResult = {
  channelId: string
  organizationId: string
  projectId: string
  teamId: string
  user: User
}

export type SeedBootstrapOptions = Omit<BootstrapUserSeedInput, 'userId'> & {
  userId?: string
}

export const seedBootstrapRecords = async (
  prisma: PrismaClient,
  input: SeedBootstrapOptions,
): Promise<BootstrapSeedResult> => {
  const plan = createBootstrapSeedPlan({
    ...input,
    userId: parseUserId(input.userId ?? randomUUID()),
  })

  return prisma.$transaction(async (transaction) => {
    const user = await transaction.user.create({
      data: {
        id: plan.user.id,
        email: plan.user.email,
        displayName: plan.user.displayName,
        passwordHash: plan.user.passwordHash,
        avatarUrl: plan.user.avatarUrl,
        pronouns: plan.user.pronouns,
      },
    })

    await transaction.organization.upsert({
      where: { id: plan.organization.id },
      update: { name: plan.organization.name },
      create: {
        id: plan.organization.id,
        name: plan.organization.name,
      },
    })

    await transaction.project.upsert({
      where: { id: plan.project.id },
      update: {
        name: plan.project.name,
        organizationId: plan.project.organizationId,
      },
      create: {
        id: plan.project.id,
        name: plan.project.name,
        organizationId: plan.project.organizationId,
      },
    })

    await transaction.team.upsert({
      where: { id: plan.team.id },
      update: {
        name: plan.team.name,
        projectId: plan.team.projectId,
      },
      create: {
        id: plan.team.id,
        name: plan.team.name,
        projectId: plan.team.projectId,
      },
    })

    await transaction.channel.upsert({
      where: { id: plan.channel.id },
      update: {
        label: plan.channel.label,
        organizationId: plan.channel.organizationId,
        teamId: plan.channel.teamId,
        visibility: plan.channel.visibility,
      },
      create: {
        id: plan.channel.id,
        label: plan.channel.label,
        organizationId: plan.channel.organizationId,
        teamId: plan.channel.teamId,
        visibility: plan.channel.visibility,
      },
    })

    await transaction.organizationMember.create({
      data: {
        organizationId: plan.organizationMember.organizationId,
        role: plan.organizationMember.role,
        userId: plan.organizationMember.userId,
      },
    })

    await transaction.projectMember.create({
      data: {
        projectId: plan.projectMember.projectId,
        role: plan.projectMember.role,
        userId: plan.projectMember.userId,
      },
    })

    await transaction.teamMember.create({
      data: {
        teamId: plan.teamMember.teamId,
        role: plan.teamMember.role,
        userId: plan.teamMember.userId,
      },
    })

    await transaction.channelMember.create({
      data: {
        channelId: plan.channelMember.channelId,
        userId: plan.channelMember.userId,
      },
    })

    return {
      channelId: plan.channel.id,
      organizationId: plan.organization.id,
      projectId: plan.project.id,
      teamId: plan.team.id,
      user,
    }
  })
}
