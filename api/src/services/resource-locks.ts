import type { PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseOrganizationId,
  parseRunId,
} from '@nessie/schemas'
import type { ResourceLockRecord } from '../contracts.js'
import { parseOptional } from './contract-helpers.js'

const DEFAULT_LOCK_TTL_MS = 60_000

const mapResourceLock = (lock: {
  acquiredAt: Date
  agentId: string
  expiresAt: Date
  id: string
  lockType: 'exclusive' | 'shared'
  organizationId: string
  planId: string | null
  releasedAt: Date | null
  resourcePath: string
  runId: string | null
}): ResourceLockRecord => ({
  id: lock.id,
  organizationId: parseOrganizationId(lock.organizationId),
  planId: lock.planId ?? undefined,
  runId: parseOptional(lock.runId, parseRunId),
  agentId: parseAgentId(lock.agentId),
  resourcePath: lock.resourcePath,
  lockType: lock.lockType,
  acquiredAt: lock.acquiredAt.toISOString(),
  expiresAt: lock.expiresAt.toISOString(),
  releasedAt: lock.releasedAt?.toISOString(),
})

export const listResourceLocks = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    agentId?: string
  },
): Promise<ResourceLockRecord[]> => {
  const now = new Date()
  const locks = await prisma.resourceLock.findMany({
    where: {
      organizationId,
      releasedAt: null,
      expiresAt: {
        gt: now,
      },
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
    orderBy: [{ acquiredAt: 'desc' }],
  })

  return locks.map(mapResourceLock)
}

export const acquireResourceLock = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    agentId: string
    expiresAt?: string
    lockType?: 'exclusive' | 'shared'
    planId?: string
    resourcePath: string
    runId?: string
  },
): Promise<ResourceLockRecord | null> => {
  const lockType = input.lockType ?? 'exclusive'
  const now = new Date()
  const expiresAt = input.expiresAt
    ? new Date(input.expiresAt)
    : new Date(now.getTime() + DEFAULT_LOCK_TTL_MS)

  const conflictingLock = await prisma.resourceLock.findFirst({
    where: {
      organizationId,
      resourcePath: input.resourcePath,
      releasedAt: null,
      expiresAt: {
        gt: now,
      },
      ...(lockType === 'shared'
        ? { lockType: 'exclusive' }
        : {}),
    },
    orderBy: [{ acquiredAt: 'asc' }],
  })

  if (conflictingLock) {
    return null
  }

  const lock = await prisma.resourceLock.create({
    data: {
      organizationId,
      planId: input.planId,
      runId: input.runId,
      agentId: input.agentId,
      resourcePath: input.resourcePath,
      lockType,
      expiresAt,
    },
  })

  return mapResourceLock(lock)
}

export const releaseResourceLock = async (
  prisma: PrismaClient,
  organizationId: string,
  lockId: string,
): Promise<ResourceLockRecord | null> => {
  const lock = await prisma.resourceLock.findFirst({
    where: {
      id: lockId,
      organizationId,
    },
    select: { id: true },
  })
  if (!lock) {
    return null
  }

  const released = await prisma.resourceLock.update({
    where: { id: lockId },
    data: {
      releasedAt: new Date(),
    },
  })

  return mapResourceLock(released)
}
