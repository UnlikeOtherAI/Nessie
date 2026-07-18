import type { PrismaClient } from '@prisma/client'
import type { McpCatalogEntryRow } from '@nessie/mcp-manage'

const DEEP_WATER_SLUG = 'deep-water'

export type McpCatalogApiEntry = McpCatalogEntryRow & {
  managedByIntegration: boolean
}

export const isManagedDeepWaterCatalogRecord = (
  entry: Pick<McpCatalogEntryRow, 'name' | 'organizationId' | 'visibility'>,
  linkedProductSlugs: readonly string[],
): boolean =>
  entry.name === DEEP_WATER_SLUG
  && entry.organizationId === null
  && entry.visibility === 'public'
  && linkedProductSlugs.includes(DEEP_WATER_SLUG)

export const presentCatalogEntries = async (
  prisma: PrismaClient,
  entries: McpCatalogEntryRow[],
): Promise<McpCatalogApiEntry[]> => {
  if (entries.length === 0) {
    return []
  }

  const products = await prisma.integratedProduct.findMany({
    where: {
      mcpCatalogEntryId: { in: entries.map((entry) => entry.id) },
    },
    select: {
      mcpCatalogEntryId: true,
      slug: true,
    },
  })
  const slugsByCatalogId = new Map<string, string[]>()
  for (const product of products) {
    if (!product.mcpCatalogEntryId) continue
    const slugs = slugsByCatalogId.get(product.mcpCatalogEntryId) ?? []
    slugs.push(product.slug)
    slugsByCatalogId.set(product.mcpCatalogEntryId, slugs)
  }

  return entries.map((entry) => ({
    ...entry,
    managedByIntegration: isManagedDeepWaterCatalogRecord(
      entry,
      slugsByCatalogId.get(entry.id) ?? [],
    ),
  }))
}

export const presentCatalogEntry = async (
  prisma: PrismaClient,
  entry: McpCatalogEntryRow,
): Promise<McpCatalogApiEntry> => {
  const [presented] = await presentCatalogEntries(prisma, [entry])
  if (!presented) {
    throw new Error('Catalog response mapping failed')
  }
  return presented
}
