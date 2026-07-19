import type { PrismaClient } from '@prisma/client'

import {
  MCP_INSTANCE_ERROR_CODES,
  McpInstanceError,
} from './mcp-instance-errors.js'

const DEEP_WATER_PRODUCT_SLUG = 'deep-water'
const MANAGED_PRODUCT_SLUGS = [DEEP_WATER_PRODUCT_SLUG, 'deepsignal'] as const

type ManagedCatalog = {
  integratedProducts?: Array<{ slug: string }>
  name: string
  visibility: string
}

const isManagedCatalog = (catalog: ManagedCatalog | null | undefined): boolean =>
  Boolean(
    catalog
    && catalog.visibility === 'public'
    && MANAGED_PRODUCT_SLUGS.some(
      (slug) =>
        catalog.name === slug
        && catalog.integratedProducts?.some((product) => product.slug === slug),
    ),
  )

/**
 * DeepWater is provisioned by the first-party integration, not configured as a
 * normal user-authored connector. This identity check is shared by the REST
 * and personal-assistant credential surfaces so neither can create a personal
 * override that shadows Nessie's product-bound Ledger app API key.
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

/**
 * First-party connector instances whose app credential and lifecycle are owned
 * by Integrations. Users may activate/deactivate them through the product
 * surface but may not replace the product-bound application credential.
 */
export const isManagedIntegrationInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  instanceId: string,
): Promise<boolean> => {
  const instance = await prisma.mcpServerInstance.findFirst({
    where: {
      id: instanceId,
      organizationId,
      catalogEntry: {
        name: { in: [...MANAGED_PRODUCT_SLUGS] },
        visibility: 'public',
        integratedProducts: {
          some: { slug: { in: [...MANAGED_PRODUCT_SLUGS] } },
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
  return isManagedCatalog(instance?.catalogEntry)
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

export const isManagedIntegrationCatalogEntry = async (
  prisma: PrismaClient,
  catalogEntryId: string,
): Promise<boolean> => {
  const entry = await prisma.mcpCatalogEntry.findFirst({
    where: {
      id: catalogEntryId,
      name: { in: [...MANAGED_PRODUCT_SLUGS] },
      visibility: 'public',
      integratedProducts: {
        some: { slug: { in: [...MANAGED_PRODUCT_SLUGS] } },
      },
    },
    select: {
      name: true,
      visibility: true,
      integratedProducts: { select: { slug: true } },
    },
  })
  return isManagedCatalog(entry)
}

/**
 * Generic MCP lifecycle operations cannot safely probe or remove the
 * integration-owned DeepWater instance. Its transport needs signed Nessie
 * identity, and its row must stay transactionally aligned with the product
 * enablement toggle. The Integrations transition is therefore its sole
 * lifecycle owner.
 */
export const assertCatalogLifecycleIsUserManaged = async (
  prisma: PrismaClient,
  catalogEntryId: string,
): Promise<void> => {
  if (!(await isManagedIntegrationCatalogEntry(prisma, catalogEntryId))) return

  throw new McpInstanceError(
    MCP_INSTANCE_ERROR_CODES.MANAGED_BY_INTEGRATION,
    'This first-party connector lifecycle is managed from Integrations.',
  )
}
