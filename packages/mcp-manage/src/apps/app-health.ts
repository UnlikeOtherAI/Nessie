import type { PrismaClient } from '@prisma/client'

/**
 * The only health fact the member-facing store reads: did the last probe reach
 * the app's server at all. Latency, failure counts, and probe errors are
 * owner-ops telemetry outside the member surface — a card shows an outcome,
 * never a diagnosis.
 */
export const loadUnreachableAppIds = async (
  prisma: PrismaClient,
  catalogEntryIds: readonly string[],
): Promise<Set<string>> => {
  if (catalogEntryIds.length === 0) return new Set()
  const rows = await prisma.mcpServerHealth.findMany({
    where: { catalogEntryId: { in: [...catalogEntryIds] }, reachable: false },
    select: { catalogEntryId: true },
  })
  return new Set(rows.map((row) => row.catalogEntryId))
}

/**
 * One capability-discovery outcome, in the shape the health table records.
 * Structurally satisfied by `AppCapabilityDiscovery`, so `persistAppCapabilities`
 * hands its result straight over without a mapping step to keep in sync.
 */
export type AppHealthSnapshot = {
  reachable: boolean
  initializationSuccessful: boolean
  latencyMs: number
  toolCount: number | null
  resourceCount: number | null
  promptCount: number | null
  error: string | null
}

/**
 * Upstream transport messages are unbounded — a misconfigured server answers a
 * probe with a full HTML error page — and this column exists to be read by a
 * person, not stored verbatim.
 */
const MAX_ERROR_CHARS = 500

/**
 * Record the last known health of an app's advertised endpoint.
 *
 * `error` is owner-ops diagnosis and never reaches a member surface: the store
 * reads reachability alone (`loadUnreachableAppIds`) and the presenter's
 * allowlist cannot emit this string, an endpoint URL, or anything else the
 * upstream message may carry. Nothing credential-bearing is written here —
 * resolved transport headers are never part of a probe error.
 */
export const recordAppHealth = async (
  prisma: PrismaClient,
  catalogEntryId: string,
  snapshot: AppHealthSnapshot,
  checkedAt: Date = new Date(),
): Promise<void> => {
  const row = {
    reachable: snapshot.reachable,
    initializationSuccessful: snapshot.initializationSuccessful,
    latencyMs: snapshot.latencyMs,
    toolCount: snapshot.toolCount,
    resourceCount: snapshot.resourceCount,
    promptCount: snapshot.promptCount,
    checkedAt,
    error: snapshot.error === null ? null : snapshot.error.slice(0, MAX_ERROR_CHARS),
  }
  await prisma.mcpServerHealth.upsert({
    where: { catalogEntryId },
    create: { catalogEntryId, ...row },
    update: row,
  })
}
