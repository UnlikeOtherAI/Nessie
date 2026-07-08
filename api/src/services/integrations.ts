import { Prisma, type PrismaClient } from '@prisma/client'
import {
  IntegratedProductResponseSchema,
  type IntegratedProductResponse,
} from '@nessie/schemas'

type ProductOwner = {
  organizationId: string
  userId: string
}

type IntegratedProductRow = {
  id: string
  slug: string
  name: string
  summary: string
  category: string
  launch_url: string | null
  api_base_url: string | null
  auth_mode: string
  default_install_state: string
  mcp_catalog_entry_id: string | null
  plugin_manifest_ref: string | null
  health_status: string
  health_detail: string | null
  capabilities: string[] | null
  setup_hint: string | null
  sort_order: number
  created_at: Date | string
  updated_at: Date | string
  account_link_id: string | null
  account_organization_id: string | null
  account_user_id: string | null
  account_uoa_sub: string | null
  account_external_account_id: string | null
  account_active_org_id: string | null
  account_active_team_id: string | null
  account_status: string | null
  account_last_verified_at: Date | string | null
  account_metadata_json: unknown
}

const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()

const toNullableIsoString = (value: Date | string | null): string | null =>
  value ? toIsoString(value) : null

const toMetadataRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

const mapProductRow = (row: IntegratedProductRow): IntegratedProductResponse =>
  IntegratedProductResponseSchema.parse({
    id: row.id,
    accountLink: row.account_link_id
      ? {
          id: row.account_link_id,
          activeOrgId: row.account_active_org_id,
          activeTeamId: row.account_active_team_id,
          externalAccountId: row.account_external_account_id,
          lastVerifiedAt: toNullableIsoString(row.account_last_verified_at),
          metadata: toMetadataRecord(row.account_metadata_json),
          organizationId: row.account_organization_id,
          productSlug: row.slug,
          status: row.account_status,
          uoaSub: row.account_uoa_sub,
          userId: row.account_user_id,
        }
      : null,
    apiBaseUrl: row.api_base_url,
    authMode: row.auth_mode,
    capabilities: row.capabilities ?? [],
    category: row.category,
    createdAt: toIsoString(row.created_at),
    defaultInstallState: row.default_install_state,
    healthDetail: row.health_detail,
    healthStatus: row.health_status,
    launchUrl: row.launch_url,
    mcpCatalogEntryId: row.mcp_catalog_entry_id,
    name: row.name,
    pluginManifestRef: row.plugin_manifest_ref,
    setupHint: row.setup_hint,
    slug: row.slug,
    sortOrder: row.sort_order,
    summary: row.summary,
    updatedAt: toIsoString(row.updated_at),
  })

export const listIntegratedProducts = async (
  prisma: PrismaClient,
  owner: ProductOwner,
): Promise<IntegratedProductResponse[]> => {
  const rows = await prisma.$queryRaw<IntegratedProductRow[]>(Prisma.sql`
    SELECT
      p.id::text AS id,
      p.slug,
      p.name,
      p.summary,
      p.category::text AS category,
      p.launch_url,
      p.api_base_url,
      p.auth_mode::text AS auth_mode,
      p.default_install_state::text AS default_install_state,
      p.mcp_catalog_entry_id::text AS mcp_catalog_entry_id,
      p.plugin_manifest_ref,
      p.health_status::text AS health_status,
      p.health_detail,
      p.capabilities,
      p.setup_hint,
      p.sort_order,
      p.created_at,
      p.updated_at,
      pal.id::text AS account_link_id,
      pal.organization_id::text AS account_organization_id,
      pal.user_id::text AS account_user_id,
      pal.uoa_sub AS account_uoa_sub,
      pal.external_account_id AS account_external_account_id,
      pal.active_org_id AS account_active_org_id,
      pal.active_team_id AS account_active_team_id,
      pal.status::text AS account_status,
      pal.last_verified_at AS account_last_verified_at,
      pal.metadata_json AS account_metadata_json
    FROM integrated_products p
    LEFT JOIN product_account_links pal
      ON pal.product_slug = p.slug
      AND pal.organization_id = CAST(${owner.organizationId} AS uuid)
      AND pal.user_id = CAST(${owner.userId} AS uuid)
    ORDER BY p.sort_order ASC, p.name ASC
  `)

  return rows.map(mapProductRow)
}
