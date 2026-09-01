import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient, type User } from '@prisma/client'
import { parseUserId } from '@nessie/schemas'
import { defaultColumnCreateData } from '../services/board.js'
import { seedDefaultPolicies } from '../services/policy.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from '../services/user-session-lock.js'
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

export class BootstrapAlreadyInitializedError extends Error {
  constructor() {
    super('Bootstrap is no longer available.')
    this.name = 'BootstrapAlreadyInitializedError'
  }
}

export const lockBootstrapInitialization = async (
  transaction: Pick<Prisma.TransactionClient, '$queryRaw'>,
): Promise<void> => {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended('nessie:bootstrap-initialization', 0)
      )
    ) AS acquired
  `)
}

export const seedBootstrapRecordsInTransaction = async (
  transaction: Prisma.TransactionClient,
  input: SeedBootstrapOptions,
): Promise<BootstrapSeedResult> => {
  const plan = createBootstrapSeedPlan({
    ...input,
    userId: parseUserId(input.userId ?? randomUUID()),
  })

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

  // Seed the default board columns for the bootstrap project (idempotent:
  // only when the project has none yet).
  if ((await transaction.boardColumn.count({ where: { projectId: plan.project.id } })) === 0) {
    await transaction.boardColumn.createMany({
      data: defaultColumnCreateData(plan.project.organizationId).map((column) => ({
        ...column,
        projectId: plan.project.id,
      })),
    })
  }

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
      projectId: plan.channel.projectId,
      slug: plan.channel.slug,
      teamId: plan.channel.teamId,
      visibility: plan.channel.visibility,
    },
    create: {
      id: plan.channel.id,
      label: plan.channel.label,
      organizationId: plan.channel.organizationId,
      projectId: plan.channel.projectId,
      slug: plan.channel.slug,
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

  await seedDefaultPolicies(transaction, plan.organization.id, user.id)

  return {
    channelId: plan.channel.id,
    organizationId: plan.organization.id,
    projectId: plan.project.id,
    teamId: plan.team.id,
    user,
  }
}

export const seedBootstrapRecords = async (
  prisma: PrismaClient,
  input: SeedBootstrapOptions,
): Promise<BootstrapSeedResult> => prisma.$transaction(async (transaction) => {
  await lockBootstrapInitialization(transaction)
  const [organizationCount, userCount] = await Promise.all([
    transaction.organization.count(),
    transaction.user.count(),
  ])
  if (organizationCount > 0 || userCount > 0) {
    throw new BootstrapAlreadyInitializedError()
  }
  return seedBootstrapRecordsInTransaction(transaction, input)
}, AUTH_LOCK_TRANSACTION_OPTIONS)
