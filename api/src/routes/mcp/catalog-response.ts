import type { PrismaClient } from '@prisma/client'
import {
  isManagedIntegrationCatalogRecord,
  type McpCatalogEntryRow,
} from '@nessie/mcp-manage'

export type McpCatalogApiEntry = Omit<McpCatalogEntryRow, 'authConfig'> & {
  authConfig: unknown
  managedByIntegration: boolean
}

export const redactCatalogAuthConfig = (authConfig: unknown): unknown => {
  if (
    !authConfig
    || typeof authConfig !== 'object'
    || Array.isArray(authConfig)
  ) {
    return authConfig
  }
  const safe = { ...authConfig } as Record<string, unknown>
  delete safe.clientSecret
  return safe
}

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
    authConfig: redactCatalogAuthConfig(entry.authConfig),
    managedByIntegration: isManagedIntegrationCatalogRecord(
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
