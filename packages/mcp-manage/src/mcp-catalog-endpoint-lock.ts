import type { PrismaClient } from '@prisma/client'

import type { McpCatalogEntryRow } from './mcp-catalog.js'

const endpointUrlOf = (
  entry: { defaultTransportConfig: unknown },
): string | null => {
  const config = entry.defaultTransportConfig
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const url = (config as Record<string, unknown>).url
    if (typeof url === 'string' && url.length > 0) {
      return url.replace(/\/+$/, '')
    }
  }
  return null
}

/**
 * Resolve an entry lock or an org/global lock for the same normalized endpoint.
 */
export const findApplicableLock = async (
  prisma: PrismaClient,
  organizationId: string,
  entry: Pick<
    McpCatalogEntryRow,
    'locked' | 'label' | 'defaultTransportConfig'
  > | null,
  endpointUrl?: string | null,
): Promise<{ label: string } | null> => {
  if (entry?.locked) return { label: entry.label }
  const url = endpointUrl?.replace(/\/+$/, '')
    ?? (entry ? endpointUrlOf(entry) : null)
  if (!url) return null
  const lockedEntries = await prisma.mcpCatalogEntry.findMany({
    where: {
      locked: true,
      OR: [{ organizationId }, { organizationId: null }],
    },
    select: { label: true, defaultTransportConfig: true },
  })
  for (const candidate of lockedEntries) {
    if (endpointUrlOf(candidate) === url) {
      return { label: candidate.label }
    }
  }
  return null
}
