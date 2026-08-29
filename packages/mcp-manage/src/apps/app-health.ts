import type { PrismaClient } from '@prisma/client'

/**
 * The only health fact the member-facing store reads: did the last probe reach
 * the app's server at all. Latency, failure counts, and probe errors are
 * owner-ops telemetry and stay on the Connectors page — a card shows an
 * outcome, never a diagnosis.
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
