import type { PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseOrganizationId,
  parseRunId,
} from '@nessie/schemas'
import type { ResourceLockRecord } from '../contracts/execution.js'
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

  const lock = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext(${input.resourcePath})
      )
    `

    const conflictingLock = await tx.resourceLock.findFirst({
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

    return tx.resourceLock.create({
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
  })

  return lock ? mapResourceLock(lock) : null
}

/**
 * Release a lock the given agent holds.
 *
 * `agentId` is required, and `releasedAt: null` is part of the predicate. Being
 * in the organisation is not an entitlement to drop somebody else's lock — a
 * lock is held BY an agent, and releasing it is the one operation whose whole
 * point is that only the holder does it. The `releasedAt` filter is what makes
 * a second release a 404 rather than a silent overwrite of the original release
 * time, which would misreport how long the resource was actually held.
 *
 * Returns null when there is no unreleased lock with that id, in that
 * organisation, held by that agent — the three are deliberately one refusal, so
 * a caller cannot probe for the existence of another agent's lock.
 */
export const releaseResourceLock = async (
  prisma: PrismaClient,
  organizationId: string,
  input: { agentId: string; lockId: string },
): Promise<ResourceLockRecord | null> => {
  const released = await prisma.resourceLock.updateManyAndReturn({
    where: {
      agentId: input.agentId,
      id: input.lockId,
      organizationId,
      releasedAt: null,
    },
    data: {
      releasedAt: new Date(),
    },
  })

  return released[0] ? mapResourceLock(released[0]) : null
}
