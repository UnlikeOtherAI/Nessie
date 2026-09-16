import { Prisma } from '@prisma/client'

import type { AdmissionPrismaClient } from './admission-lock.js'
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
//
// `move.out`/`move.in` are the same idea applied to a cross-space transfer:
// the bytes did not move but their scope did, and usage per project/space is
// the sum of the events, so a move writes one negative event in the old scope
// and one positive event in the new. The pair sums to zero by construction, so
// the organisation total is unchanged and a move runs no quota check.
export type StorageStoreOperation =
  | 'store'
  | 'delete'
  | 'store.thumbnail'
  | 'delete.thumbnail'
  | 'move.out'
  | 'move.in'

/**
 * Record a signed at-rest byte delta. FileService is the sole writer, making
 * current storage usage an exact sum of store and delete events.
 */
export const recordStorageStored = async (
  // Accepts a `$transaction` client so the quota check and this event can be
  // one atomic step — see `withStorageAdmission` in ./storage-quota.ts.
  prisma: AdmissionPrismaClient,
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

/**
 * Re-home one object's accounted bytes: a `move.out` in the old scope and a
 * `move.in` in the new, written as one pair.
 *
 * Callers never write the two halves themselves. A caller that wrote only the
 * negative would free bytes nobody is charged for; one that wrote only the
 * positive would charge them twice; one that used different magnitudes would
 * change the organisation total, which a move must never do — the pair sums to
 * zero by construction, which is precisely why a move runs no quota check.
 * Keeping both inserts in one function is what makes that sentence true rather
 * than a convention two call sites are trusted to honour.
 *
 * `deltaBytes` is the object's size; its sign is ignored. A zero-byte object
 * writes nothing — two zero rows would be noise in an auditable ledger.
 */
export const recordStorageScopeMoved = async (
  prisma: AdmissionPrismaClient,
  input: {
    attribution: LedgerAttribution
    from: StorageUsageScope
    to: StorageUsageScope
    deltaBytes: bigint
    attachmentId?: string | null
    metadata?: Record<string, unknown> | null
  },
): Promise<void> => {
  const size = input.deltaBytes < 0n ? -input.deltaBytes : input.deltaBytes
  if (size === 0n) return
  await recordStorageStored(prisma, {
    attribution: input.attribution,
    scope: input.from,
    deltaBytes: -size,
    operation: 'move.out',
    attachmentId: input.attachmentId ?? null,
    metadata: input.metadata ?? null,
  })
  await recordStorageStored(prisma, {
    attribution: input.attribution,
    scope: input.to,
    deltaBytes: size,
    operation: 'move.in',
    attachmentId: input.attachmentId ?? null,
    metadata: input.metadata ?? null,
  })
}

/** Sum stored bytes for an organization and any supplied narrower dimensions. */
export const currentStorageUsageBytes = async (
  prisma: AdmissionPrismaClient,
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
