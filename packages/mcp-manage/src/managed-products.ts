import type { PrismaClient } from '@prisma/client'

const DEEP_WATER_PRODUCT_SLUG = 'deep-water'

/**
 * DeepWater is provisioned by the first-party integration, not configured as a
 * normal user-authored connector. This identity check is shared by the REST
 * and personal-assistant credential surfaces so neither can create a personal
 * override that shadows Nessie's Ledger service token.
 */
export const isManagedDeepWaterInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  instanceId: string,
): Promise<boolean> => {
  const instance = await prisma.mcpServerInstance.findFirst({
    where: {
      id: instanceId,
      organizationId,
      catalogEntry: {
        name: DEEP_WATER_PRODUCT_SLUG,
        visibility: 'public',
        integratedProducts: {
          some: { slug: DEEP_WATER_PRODUCT_SLUG },
        },
      },
    },
    select: {
      catalogEntry: {
        select: {
          name: true,
          visibility: true,
          integratedProducts: { select: { slug: true } },
        },
      },
    },
  })
  const catalog = instance?.catalogEntry
  return catalog?.name === DEEP_WATER_PRODUCT_SLUG
    && catalog.visibility === 'public'
    && catalog.integratedProducts?.some(
      (product) => product.slug === DEEP_WATER_PRODUCT_SLUG,
    ) === true
}

export const isManagedDeepWaterCatalogEntry = async (
  prisma: PrismaClient,
  catalogEntryId: string,
): Promise<boolean> => {
  const entry = await prisma.mcpCatalogEntry.findFirst({
    where: {
      id: catalogEntryId,
      name: DEEP_WATER_PRODUCT_SLUG,
      visibility: 'public',
      integratedProducts: {
        some: { slug: DEEP_WATER_PRODUCT_SLUG },
      },
    },
    select: {
      name: true,
      visibility: true,
      integratedProducts: { select: { slug: true } },
    },
  })
  return entry?.name === DEEP_WATER_PRODUCT_SLUG
    && entry.visibility === 'public'
    && entry.integratedProducts?.some(
      (product) => product.slug === DEEP_WATER_PRODUCT_SLUG,
    ) === true
}
