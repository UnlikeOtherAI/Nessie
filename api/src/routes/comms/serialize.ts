import type { Prisma } from '@prisma/client'
import type {
  CommsConnectionDetail,
  CommsConnectionSummary,
  CommsResourceRecord,
  CommsSyncJobRecord,
} from '@nessie/schemas'

/**
 * Response mappers for the communications connector surface. These translate
 * Prisma rows into the shared HTTP contract and are the single place that
 * guarantees credential material never leaks into a response — no mapper here
 * reads the `CommsConnectionCredential` relation.
 */

type ConnectionRow = Prisma.CommsConnectionGetPayload<object>
type ResourceRow = Prisma.CommsResourceGetPayload<object>
type SyncJobRow = Prisma.CommsSyncJobGetPayload<object>

const toStringArray = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []

export const serializeResource = (row: ResourceRow): CommsResourceRecord => ({
  id: row.id,
  resourceType: row.resourceType,
  externalId: row.externalId,
  name: row.name,
  visibility: row.visibility,
  userHasAccess: row.userHasAccess,
  syncEnabled: row.syncEnabled,
})

export const serializeSyncJob = (row: SyncJobRow): CommsSyncJobRecord => ({
  id: row.id,
  resourceId: row.resourceId,
  phase: row.phase,
  status: row.status,
  oldestImportedAt: row.oldestImportedAt?.toISOString() ?? null,
  newestImportedAt: row.newestImportedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export type ResourceCounts = { total: number; synced: number }

export const serializeConnectionSummary = (
  row: ConnectionRow,
  counts: ResourceCounts,
): CommsConnectionSummary => ({
  id: row.id,
  provider: row.provider,
  status: row.status,
  externalTenantId: row.externalTenantId,
  externalUserId: row.externalUserId,
  grantedScopes: toStringArray(row.grantedScopes),
  initialSyncCompletedAt: row.initialSyncCompletedAt?.toISOString() ?? null,
  lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
  resourceCount: counts.total,
  syncedResourceCount: counts.synced,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export const serializeConnectionDetail = (
  row: ConnectionRow,
  resources: ResourceRow[],
  syncJobs: SyncJobRow[],
): CommsConnectionDetail => {
  const synced = resources.filter((resource) => resource.syncEnabled).length
  return {
    ...serializeConnectionSummary(row, { total: resources.length, synced }),
    resources: resources.map(serializeResource),
    recentSyncJobs: syncJobs.map(serializeSyncJob),
  }
}
