import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

import type { LedgerAttribution } from './ledger.js'

export type StorageUsageScope = {
  organizationId: string
  projectId?: string | null
  teamId?: string | null
  spaceId?: string | null
  uploaderId?: string | null
}

// Thumbnails get their own signed events rather than being folded into the
// original's delta: usage is the sum of every row, so a preview's bytes stay
// individually auditable and its +/- pair nets to zero on delete.
export type StorageStoreOperation =
  | 'store'
  | 'delete'
  | 'store.thumbnail'
  | 'delete.thumbnail'

/**
 * Record a signed at-rest byte delta. FileService is the sole writer, making
 * current storage usage an exact sum of store and delete events.
 */
export const recordStorageStored = async (
  prisma: PrismaClient,
  input: {
    attribution: LedgerAttribution
    scope: StorageUsageScope
    deltaBytes: bigint
    operation: StorageStoreOperation
    attachmentId?: string | null
    metadata?: Record<string, unknown> | null
  },
): Promise<void> => {
  const { attribution, scope } = input
  await prisma.storageUsageEvent.create({
    data: {
      organizationId: scope.organizationId,
      projectId: scope.projectId ?? null,
      teamId: scope.teamId ?? null,
      spaceId: scope.spaceId ?? null,
      uploaderId: scope.uploaderId ?? null,
      attachmentId: input.attachmentId ?? null,
      deltaBytes: input.deltaBytes,
      operation: input.operation,
      actorId: attribution.actorId,
      actorType: attribution.actorType ?? null,
      requestId: attribution.requestId ?? null,
      correlationId: attribution.correlationId ?? null,
      occurredAt: new Date(),
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  })
}

/** Sum stored bytes for an organization and any supplied narrower dimensions. */
export const currentStorageUsageBytes = async (
  prisma: PrismaClient,
  scope: StorageUsageScope,
): Promise<bigint> => {
  const where: Prisma.StorageUsageEventWhereInput = {
    organizationId: scope.organizationId,
  }
  if (scope.projectId) {
    where.projectId = scope.projectId
  }
  if (scope.teamId) {
    where.teamId = scope.teamId
  }
  if (scope.spaceId) {
    where.spaceId = scope.spaceId
  }
  if (scope.uploaderId) {
    where.uploaderId = scope.uploaderId
  }
  const result = await prisma.storageUsageEvent.aggregate({
    _sum: { deltaBytes: true },
    where,
  })
  return result._sum.deltaBytes ?? 0n
}
