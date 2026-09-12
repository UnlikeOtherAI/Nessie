import { randomUUID } from 'node:crypto'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerDeviceRoutes } from '../src/routes/devices.js'

export const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
export const userA = '00000000-0000-4000-8000-00000000000a'
export const userB = '00000000-0000-4000-8000-00000000000b'

export type DeviceRow = {
  id: string
  organizationId: string
  userId: string
  platform: string
  token: string
  appVersion: string | null
  apnsEnvironment: 'sandbox' | 'production' | null
  registrationVersion: bigint
  deviceRecoveryKeyHash?: string | null
  ownershipProofHash?: string | null
  inactiveAt: Date | null
  lastSeenAt: Date
  createdAt: Date
}

const actorContextFor = (
  userId: string,
  activeOrganizationId = organizationId,
  pushRegistrationVersion = '0',
): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId: activeOrganizationId, projectId },
  actionContext: { requestId: `req-devices-${userId}`, pushRegistrationVersion },
})

/** In-memory physical-token store shared by route regressions. */
export const makeApp = (
  userId: string,
  rows: DeviceRow[] = [],
  activeOrganizationId = organizationId,
  pushRegistrationVersion = '0',
) => {
  let registrationGeneration = BigInt(pushRegistrationVersion)
  const prisma = {
    deviceToken: {
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          token: string
          registrationVersion?: { lte: bigint }
          organizationId?: string
          ownershipProofHash?: string | null
          deviceRecoveryKeyHash?: string | null
          userId?: string
        }
        data: {
          organizationId?: string
          userId?: string
          platform?: string
          appVersion?: string | null
          registrationVersion: bigint
          inactiveAt?: Date | null
          apnsEnvironment?: 'sandbox' | 'production' | null
          lastSeenAt?: Date
          ownershipProofHash?: string | null
          deviceRecoveryKeyHash?: string | null
        }
      }) => {
        const existing = rows.find((row) => row.token === where.token)
        if (!existing) return { count: 0 }
        if (
          where.registrationVersion
          && existing.registrationVersion > where.registrationVersion.lte
        ) return { count: 0 }
        if (where.organizationId && existing.organizationId !== where.organizationId) return { count: 0 }
        if (where.userId && existing.userId !== where.userId) return { count: 0 }
        if (where.ownershipProofHash && existing.ownershipProofHash !== where.ownershipProofHash) return { count: 0 }
        if (
          where.deviceRecoveryKeyHash !== undefined
          && existing.deviceRecoveryKeyHash !== where.deviceRecoveryKeyHash
        ) return { count: 0 }
        existing.organizationId = data.organizationId ?? existing.organizationId
        existing.userId = data.userId ?? existing.userId
        existing.platform = data.platform ?? existing.platform
        existing.appVersion = data.appVersion ?? existing.appVersion
        existing.registrationVersion = data.registrationVersion
        existing.ownershipProofHash = data.ownershipProofHash ?? existing.ownershipProofHash
        existing.deviceRecoveryKeyHash = data.deviceRecoveryKeyHash ?? existing.deviceRecoveryKeyHash
        existing.inactiveAt = data.inactiveAt === undefined ? existing.inactiveAt : data.inactiveAt
        existing.apnsEnvironment = data.apnsEnvironment === undefined
          ? existing.apnsEnvironment
          : data.apnsEnvironment
        existing.lastSeenAt = data.lastSeenAt ?? existing.lastSeenAt
        return { count: 1 }
      },
      findUnique: async ({ where }: { where: { token: string } }) =>
        rows.find((row) => row.token === where.token) ?? null,
      create: async ({
        data: create,
      }: {
        data: Omit<DeviceRow, 'id' | 'lastSeenAt' | 'createdAt'> & { appVersion?: string }
      }) => {
        const now = new Date()
        const created: DeviceRow = {
          id: randomUUID(),
          organizationId: create.organizationId,
          userId: create.userId,
          platform: create.platform,
          token: create.token,
          appVersion: create.appVersion ?? null,
          registrationVersion: create.registrationVersion,
          ownershipProofHash: create.ownershipProofHash ?? null,
          deviceRecoveryKeyHash: create.deviceRecoveryKeyHash ?? null,
          inactiveAt: create.inactiveAt ?? null,
          apnsEnvironment: create.apnsEnvironment ?? null,
          lastSeenAt: now,
          createdAt: now,
        }
        rows.push(created)
        return created
      },
    },
    pushRegistrationGeneration: {
      upsert: async () => {
        registrationGeneration += 1n
        return { value: registrationGeneration }
      },
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerDeviceRoutes(app, {
    prisma,
    requireActorContext: () => actorContextFor(userId, activeOrganizationId, pushRegistrationVersion),
  } as unknown as Parameters<typeof registerDeviceRoutes>[1])
  return { app, rows }
}
