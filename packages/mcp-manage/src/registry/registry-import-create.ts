import type { PrismaClient } from '@prisma/client'

import { isAppHomeSuggestionRegistryName } from '../apps/app-home-suggestions.js'
import { resolveAvailableAppSlug } from '../apps/app-slug.js'
import { isUniqueViolation } from '../mcp-catalog-guards.js'
import type { RegistryAppMapping } from './registry-mapper.js'
import { syncableFieldsFromMapping } from './registry-merge.js'
import { resolveAvailableCatalogName } from './registry-naming.js'

/** System provenance for a registry row no person authored. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** A name collision is a retry, not a defeat — but a bounded one. */
const CREATE_ATTEMPTS = 3

/** Create the catalogue face of a registry record, allocating stable public names. */
export const createRegistryApp = async (
  prisma: PrismaClient,
  mapping: RegistryAppMapping,
): Promise<string> => {
  const fields = syncableFieldsFromMapping(mapping)
  let conflict: unknown = null

  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const name = await resolveAvailableCatalogName(prisma, mapping.registryName)
    if (!name) throw new Error('every catalogue name candidate is taken')
    // A null slug is allowed: the store resolves an app by slug or id, so a
    // pathological collision costs the readable URL and never the row.
    const slug = await resolveAvailableAppSlug(prisma, mapping.displayName)

    try {
      const created = await prisma.mcpCatalogEntry.create({
        select: { id: true },
        data: {
          organizationId: null,
          name,
          label: fields.label,
          description: fields.description,
          protocol: mapping.protocol,
          authMethod: mapping.auth.authMethod,
          authConfig: mapping.auth.authConfig,
          defaultTransportConfig: fields.defaultTransportConfig,
          vendor: fields.vendor,
          sourceUrl: fields.sourceUrl,
          status: 'published',
          visibility: 'public',
          ownerUserId: null,
          createdBy: NIL_UUID,
          slug,
          displayName: fields.displayName,
          shortDescription: fields.shortDescription,
          websiteUrl: fields.websiteUrl,
          iconUrl: fields.iconUrl,
          documentationUrl: fields.documentationUrl,
          repositoryUrl: fields.repositoryUrl,
          primaryCategory: fields.primaryCategory,
          categories: fields.categories,
          tags: fields.tags,
          aliases: fields.aliases,
          trustLevel: fields.trustLevel,
          moderationState:
            mapping.promotable || isAppHomeSuggestionRegistryName(mapping.registryName)
              ? 'curated'
              : 'discovered',
          appSource: 'mcp_registry',
          distribution: 'remote',
          registryName: mapping.registryName,
          registryVersion: mapping.registryVersion,
          upstream: mapping.upstream,
          upstreamUpdatedAt: mapping.upstreamUpdatedAt,
        },
      })
      return created.id
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      conflict = error
    }
  }
  throw conflict ?? new Error('unable to allocate a catalogue name')
}
