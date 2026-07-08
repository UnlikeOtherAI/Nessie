import { Prisma, type PrismaClient } from '@prisma/client'
import {
  IntegratedProductResponseSchema,
  type IntegratedProductResponse,
} from '@nessie/schemas'
import type { ExternalAuthWorkspace } from './identity-display.js'

type ProductOwner = {
  organizationId: string
  teamId?: string
  userId: string
}

type UoaProductAccountLinkSyncInput = ProductOwner & {
  email: string
  externalSubject: string | undefined
  workspace: ExternalAuthWorkspace | undefined
}

type ProductSlugRow = {
  slug: string
}

type ProductTeamEnablementRow = {
  id: string
  organization_id: string
  team_id: string
  product_slug: string
  enabled: boolean
  external_org_id: string | null
  external_team_id: string | null
  configured_by_user_id: string | null
  metadata_json: unknown
  created_at: Date | string
  updated_at: Date | string
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
  team_enablement_id: string | null
  team_enablement_organization_id: string | null
  team_enablement_team_id: string | null
  team_enablement_product_slug: string | null
  team_enablement_enabled: boolean | null
  team_enablement_external_org_id: string | null
  team_enablement_external_team_id: string | null
  team_enablement_configured_by_user_id: string | null
  team_enablement_metadata_json: unknown
  team_enablement_created_at: Date | string | null
  team_enablement_updated_at: Date | string | null
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

const mapTeamEnablementRow = (
  row: ProductTeamEnablementRow,
) => ({
  id: row.id,
  configuredByUserId: row.configured_by_user_id,
  createdAt: toIsoString(row.created_at),
  enabled: row.enabled,
  externalOrgId: row.external_org_id,
  externalTeamId: row.external_team_id,
  metadata: toMetadataRecord(row.metadata_json),
  organizationId: row.organization_id,
  productSlug: row.product_slug,
  teamId: row.team_id,
  updatedAt: toIsoString(row.updated_at),
})

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
    teamEnablement: row.team_enablement_id
      ? mapTeamEnablementRow({
          id: row.team_enablement_id,
          configured_by_user_id: row.team_enablement_configured_by_user_id,
          created_at: row.team_enablement_created_at ?? row.updated_at,
          enabled: row.team_enablement_enabled ?? false,
          external_org_id: row.team_enablement_external_org_id,
          external_team_id: row.team_enablement_external_team_id,
          metadata_json: row.team_enablement_metadata_json,
          organization_id: row.team_enablement_organization_id ?? row.account_organization_id ?? '',
          product_slug: row.team_enablement_product_slug ?? row.slug,
          team_id: row.team_enablement_team_id ?? '',
          updated_at: row.team_enablement_updated_at ?? row.updated_at,
        })
      : null,
    updatedAt: toIsoString(row.updated_at),
  })

const FIRST_PARTY_PLUGIN_MANIFEST_PREFIX = 'first-party/'

const uoaLinkMetadata = (workspace?: ExternalAuthWorkspace): Prisma.InputJsonObject => {
  const metadata = {
    provider: 'uoa',
    teamIds: workspace?.teamIds ?? [],
    teamRoles: workspace?.teamRoles ?? {},
  }
  return workspace?.orgRole ? { ...metadata, orgRole: workspace.orgRole } : metadata
}

export const syncUoaProductAccountLinks = async (
  prisma: PrismaClient,
  input: UoaProductAccountLinkSyncInput,
): Promise<void> => {
  const products = await prisma.$queryRaw<ProductSlugRow[]>(Prisma.sql`
    SELECT "slug"
    FROM "integrated_products"
    WHERE "plugin_manifest_ref" LIKE ${`${FIRST_PARTY_PLUGIN_MANIFEST_PREFIX}%`}
      AND "auth_mode"::text IN ('uoa_sso', 'oauth_mcp', 'local_mcp')
  `)
  if (products.length === 0) {
    return
  }

  const now = new Date()
  const metadata = uoaLinkMetadata(input.workspace)
  const externalAccountId = input.externalSubject ?? input.email
  const activeOrgId = input.workspace?.activeOrgId ?? input.workspace?.orgId ?? null
  const activeTeamId = input.workspace?.activeTeamId ?? null
  const metadataJson = JSON.stringify(metadata)
  const uoaSub = input.externalSubject ?? null

  await prisma.$transaction(
    products.map((product) =>
      prisma.$executeRaw(Prisma.sql`
        INSERT INTO "product_account_links" (
          "id",
          "organization_id",
          "user_id",
          "product_slug",
          "uoa_sub",
          "external_account_id",
          "active_org_id",
          "active_team_id",
          "status",
          "last_verified_at",
          "metadata_json",
          "created_at",
          "updated_at"
        )
        VALUES (
          gen_random_uuid(),
          CAST(${input.organizationId} AS uuid),
          CAST(${input.userId} AS uuid),
          ${product.slug},
          ${uoaSub},
          ${externalAccountId},
          ${activeOrgId},
          ${activeTeamId},
          'linked'::"ProductAccountLinkStatus",
          ${now},
          CAST(${metadataJson} AS jsonb),
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT ("organization_id", "user_id", "product_slug") DO UPDATE SET
          "uoa_sub" = EXCLUDED."uoa_sub",
          "external_account_id" = EXCLUDED."external_account_id",
          "active_org_id" = EXCLUDED."active_org_id",
          "active_team_id" = EXCLUDED."active_team_id",
          "status" = EXCLUDED."status",
          "last_verified_at" = EXCLUDED."last_verified_at",
          "metadata_json" = EXCLUDED."metadata_json",
          "updated_at" = CURRENT_TIMESTAMP
      `),
    ),
  )
}

const teamEnablementMetadata = (): Prisma.InputJsonObject => ({
  authority: 'nessie_projection',
  source: 'esc_team_enablement',
})

export const setProductTeamEnablement = async (
  prisma: PrismaClient,
  input: ProductOwner & { enabled: boolean; productSlug: string },
): Promise<ProductTeamEnablementRow | null> => {
  if (!input.teamId) {
    return null
  }

  const metadataJson = JSON.stringify(teamEnablementMetadata())
  const rows = await prisma.$queryRaw<ProductTeamEnablementRow[]>(Prisma.sql`
    WITH account_link AS (
      SELECT
        "active_org_id",
        "active_team_id"
      FROM "product_account_links"
      WHERE "organization_id" = CAST(${input.organizationId} AS uuid)
        AND "user_id" = CAST(${input.userId} AS uuid)
        AND "product_slug" = ${input.productSlug}
      LIMIT 1
    ),
    upserted AS (
      INSERT INTO "product_team_enablements" (
        "id",
        "organization_id",
        "team_id",
        "product_slug",
        "enabled",
        "external_org_id",
        "external_team_id",
        "configured_by_user_id",
        "metadata_json",
        "created_at",
        "updated_at"
      )
      SELECT
        gen_random_uuid(),
        CAST(${input.organizationId} AS uuid),
        CAST(${input.teamId} AS uuid),
        p."slug",
        ${input.enabled},
        account_link."active_org_id",
        account_link."active_team_id",
        CAST(${input.userId} AS uuid),
        CAST(${metadataJson} AS jsonb),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM "integrated_products" p
      JOIN "teams" t
        ON t."id" = CAST(${input.teamId} AS uuid)
      JOIN "projects" pr
        ON pr."id" = t."project_id"
        AND pr."organization_id" = CAST(${input.organizationId} AS uuid)
      LEFT JOIN account_link ON TRUE
      WHERE p."slug" = ${input.productSlug}
      ON CONFLICT ("organization_id", "team_id", "product_slug") DO UPDATE SET
        "enabled" = EXCLUDED."enabled",
        "external_org_id" = EXCLUDED."external_org_id",
        "external_team_id" = EXCLUDED."external_team_id",
        "configured_by_user_id" = EXCLUDED."configured_by_user_id",
        "metadata_json" = EXCLUDED."metadata_json",
        "updated_at" = CURRENT_TIMESTAMP
      RETURNING
        "id"::text AS "id",
        "organization_id"::text AS "organization_id",
        "team_id"::text AS "team_id",
        "product_slug",
        "enabled",
        "external_org_id",
        "external_team_id",
        "configured_by_user_id"::text AS "configured_by_user_id",
        "metadata_json",
        "created_at",
        "updated_at"
    )
    SELECT * FROM upserted
  `)

  return rows[0] ?? null
}

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
      pal.metadata_json AS account_metadata_json,
      pte.id::text AS team_enablement_id,
      pte.organization_id::text AS team_enablement_organization_id,
      pte.team_id::text AS team_enablement_team_id,
      pte.product_slug AS team_enablement_product_slug,
      pte.enabled AS team_enablement_enabled,
      pte.external_org_id AS team_enablement_external_org_id,
      pte.external_team_id AS team_enablement_external_team_id,
      pte.configured_by_user_id::text AS team_enablement_configured_by_user_id,
      pte.metadata_json AS team_enablement_metadata_json,
      pte.created_at AS team_enablement_created_at,
      pte.updated_at AS team_enablement_updated_at
    FROM integrated_products p
    LEFT JOIN product_account_links pal
      ON pal.product_slug = p.slug
      AND pal.organization_id = CAST(${owner.organizationId} AS uuid)
      AND pal.user_id = CAST(${owner.userId} AS uuid)
    LEFT JOIN product_team_enablements pte
      ON pte.product_slug = p.slug
      AND pte.organization_id = CAST(${owner.organizationId} AS uuid)
      AND pte.team_id = CAST(${owner.teamId ?? null} AS uuid)
    ORDER BY p.sort_order ASC, p.name ASC
  `)

  return rows.map(mapProductRow)
}
