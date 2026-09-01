import type { PrismaClient } from '@prisma/client'

import type { McpCatalogEntryRow } from './mcp-catalog.js'
import { normalizeEndpoint } from './registry/registry-mapper.js'

const endpointUrlOf = (
  entry: { defaultTransportConfig: unknown },
): string | null => {
  const config = entry.defaultTransportConfig
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const url = (config as Record<string, unknown>).url
    if (typeof url === 'string' && url.length > 0) {
      // Canonical on BOTH sides. Stripping trailing slashes and comparing the
      // raw strings let a semantically identical URL slip a lock: a member
      // could install `https://API.Example.com:443/mcp` past a lock recorded
      // on `https://api.example.com/mcp`. Registry ingestion made that routine
      // rather than hypothetical, since it creates rows from URLs the
      // publisher wrote however they liked.
      return normalizeEndpoint(url) ?? url.replace(/\/+$/, '')
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
