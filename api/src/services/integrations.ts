import { Prisma, type PrismaClient } from '@prisma/client'
import type { IntegratedProductResponse } from '@nessie/schemas'
import type { ExternalAuthWorkspace } from './identity-display.js'
import {
  mapProductRow,
  type IntegratedProductRow,
  type ProductTeamEnablementRow,
} from './integration-product-rows.js'

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

/**
 * Upsert a single per-user product account link, preserving the recorded
 * `uoaSub` unless a new one is supplied. Used by the external-agent activation
 * flow to record link state (`linked` / `needs_auth` / `revoked`) alongside the
 * bulk `syncUoaProductAccountLinks` path that runs at UOA login.
 */
export const upsertProductAccountLink = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    productSlug: string
    status: 'linked' | 'needs_auth' | 'revoked' | 'error'
    uoaSub?: string | null
  },
): Promise<void> => {
  await prisma.productAccountLink.upsert({
    where: {
      organizationId_userId_productSlug: {
        organizationId: input.organizationId,
        userId: input.userId,
        productSlug: input.productSlug,
      },
    },
    create: {
      organizationId: input.organizationId,
      userId: input.userId,
      productSlug: input.productSlug,
      status: input.status,
      uoaSub: input.uoaSub ?? null,
      lastVerifiedAt: new Date(),
    },
    update: {
      status: input.status,
      lastVerifiedAt: new Date(),
      ...(input.uoaSub !== undefined ? { uoaSub: input.uoaSub } : {}),
    },
  })
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
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
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
      pte.updated_at AS team_enablement_updated_at,
      mcp_instance.id::text AS mcp_instance_id,
      mcp_instance.catalog_entry_id::text AS mcp_instance_catalog_entry_id,
      mcp_instance.scope_type::text AS mcp_instance_scope_type,
      mcp_instance.scope_id::text AS mcp_instance_scope_id,
      mcp_instance.lifecycle_state::text AS mcp_instance_lifecycle_state,
      mcp_instance.health_last_checked_at AS mcp_instance_health_last_checked_at,
      mcp_instance.health_failure_count AS mcp_instance_health_failure_count,
      mcp_instance.last_error AS mcp_instance_last_error,
      mcp_instance.tool_count AS mcp_instance_tool_count,
      mcp_instance.created_at AS mcp_instance_created_at,
      mcp_instance.updated_at AS mcp_instance_updated_at,
      product_usage.month_start AS product_usage_month_start,
      product_usage.total_calls AS product_usage_total_calls,
      product_usage.total_units AS product_usage_total_units,
      product_usage.total_cost AS product_usage_total_cost,
      product_usage.currency AS product_usage_currency,
      product_usage.last_used_at AS product_usage_last_used_at,
      product_usage.last_operation AS product_usage_last_operation,
      product_usage.success_count AS product_usage_success_count,
      product_usage.failure_count AS product_usage_failure_count
    FROM integrated_products p
    LEFT JOIN product_account_links pal
      ON pal.product_slug = p.slug
      AND pal.organization_id = CAST(${owner.organizationId} AS uuid)
      AND pal.user_id = CAST(${owner.userId} AS uuid)
    LEFT JOIN product_team_enablements pte
      ON pte.product_slug = p.slug
      AND pte.organization_id = CAST(${owner.organizationId} AS uuid)
      AND pte.team_id = CAST(${owner.teamId ?? null} AS uuid)
    LEFT JOIN LATERAL (
      SELECT
        msi.id,
        msi.catalog_entry_id,
        msi.scope_type,
        msi.scope_id,
        msi.lifecycle_state,
        msi.health_last_checked_at,
        msi.health_failure_count,
        msi.last_error,
        CASE
          WHEN jsonb_typeof(msi.discovered_tools) = 'array'
            THEN jsonb_array_length(msi.discovered_tools)
          ELSE 0
        END AS tool_count,
        msi.created_at,
        msi.updated_at
      FROM mcp_server_instances msi
      WHERE p.mcp_catalog_entry_id IS NOT NULL
        AND msi.catalog_entry_id = p.mcp_catalog_entry_id
        AND msi.organization_id = CAST(${owner.organizationId} AS uuid)
        AND (
          (
            CAST(${owner.teamId ?? null} AS uuid) IS NOT NULL
            AND msi.scope_type = 'team'::"McpServerScopeType"
            AND msi.scope_id = CAST(${owner.teamId ?? null} AS uuid)
          )
          OR (
            msi.scope_type = 'organization'::"McpServerScopeType"
            AND msi.scope_id = CAST(${owner.organizationId} AS uuid)
          )
          OR msi.scope_type = 'system'::"McpServerScopeType"
        )
      ORDER BY
        CASE
          WHEN msi.scope_type = 'team'::"McpServerScopeType" THEN 1
          WHEN msi.scope_type = 'organization'::"McpServerScopeType" THEN 2
          WHEN msi.scope_type = 'system'::"McpServerScopeType" THEN 3
          ELSE 4
        END,
        CASE
          WHEN msi.lifecycle_state = 'active'::"McpServerLifecycleState" THEN 1
          WHEN msi.lifecycle_state = 'pending_setup'::"McpServerLifecycleState" THEN 2
          WHEN msi.lifecycle_state = 'error'::"McpServerLifecycleState" THEN 3
          ELSE 4
        END,
        msi.updated_at DESC
      LIMIT 1
    ) mcp_instance ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        CAST(${monthStart} AS timestamptz) AS month_start,
        COALESCE(SUM(cue.calls), 0) AS total_calls,
        COALESCE(SUM(cue.units), 0) AS total_units,
        COALESCE(SUM(cue.cost_amount), 0) AS total_cost,
        COALESCE(
          (
            ARRAY_AGG(cue.cost_currency ORDER BY cue.occurred_at DESC)
            FILTER (WHERE cue.cost_currency IS NOT NULL)
          )[1],
          'USD'
        ) AS currency,
        MAX(cue.occurred_at) AS last_used_at,
        (
          ARRAY_AGG(cue.operation ORDER BY cue.occurred_at DESC)
          FILTER (WHERE cue.operation IS NOT NULL)
        )[1] AS last_operation,
        COALESCE(SUM(CASE WHEN cue.success IS TRUE THEN 1 ELSE 0 END), 0) AS success_count,
        COALESCE(SUM(CASE WHEN cue.success IS FALSE THEN 1 ELSE 0 END), 0) AS failure_count
      FROM connector_usage_events cue
      WHERE cue.organization_id = CAST(${owner.organizationId} AS uuid)
        AND cue.occurred_at >= CAST(${monthStart} AS timestamptz)
        AND (
          (
            mcp_instance.id IS NOT NULL
            AND cue.connector_id = mcp_instance.id
          )
          OR cue.metadata->>'productSlug' = p.slug
          OR cue.metadata->>'product_slug' = p.slug
          OR cue.metadata->>'product' = p.slug
        )
    ) product_usage ON TRUE
    ORDER BY p.sort_order ASC, p.name ASC
  `)

  return rows.map(mapProductRow)
}
