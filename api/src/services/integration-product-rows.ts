import type { Prisma } from '@prisma/client'
import {
  IntegratedProductResponseSchema,
  type IntegratedProductResponse,
  type ProductTeamEnablementAuthority,
} from '@nessie/schemas'

export type ProductTeamEnablementRow = {
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

export type IntegratedProductRow = {
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
  mcp_instance_id: string | null
  mcp_instance_catalog_entry_id: string | null
  mcp_instance_scope_type: string | null
  mcp_instance_scope_id: string | null
  mcp_instance_lifecycle_state: string | null
  mcp_instance_health_last_checked_at: Date | string | null
  mcp_instance_health_failure_count: number | null
  mcp_instance_last_error: string | null
  mcp_instance_tool_count: number | bigint | null
  mcp_instance_created_at: Date | string | null
  mcp_instance_updated_at: Date | string | null
  product_usage_month_start: Date | string
  product_usage_total_calls: number | bigint | null
  product_usage_total_units: number | bigint | null
  product_usage_total_cost: number | Prisma.Decimal | null
  product_usage_currency: string | null
  product_usage_last_used_at: Date | string | null
  product_usage_last_operation: string | null
  product_usage_success_count: number | bigint | null
  product_usage_failure_count: number | bigint | null
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

const toTeamEnablementAuthority = (
  metadata: Record<string, unknown>,
): ProductTeamEnablementAuthority =>
  metadata.authority === 'uoa_connected_products'
    ? 'uoa_connected_products'
    : 'nessie_projection'

export const mapTeamEnablementRow = (
  row: ProductTeamEnablementRow,
) => {
  const metadata = toMetadataRecord(row.metadata_json)
  return {
    id: row.id,
    authority: toTeamEnablementAuthority(metadata),
    configuredByUserId: row.configured_by_user_id,
    createdAt: toIsoString(row.created_at),
    enabled: row.enabled,
    externalOrgId: row.external_org_id,
    externalTeamId: row.external_team_id,
    metadata,
    organizationId: row.organization_id,
    productSlug: row.product_slug,
    teamId: row.team_id,
    updatedAt: toIsoString(row.updated_at),
  }
}

export const mapProductRow = (row: IntegratedProductRow): IntegratedProductResponse =>
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
    mcpInstallation: row.mcp_instance_id
      ? {
          id: row.mcp_instance_id,
          catalogEntryId: row.mcp_instance_catalog_entry_id,
          createdAt: toIsoString(row.mcp_instance_created_at ?? row.updated_at),
          healthFailureCount: row.mcp_instance_health_failure_count ?? 0,
          healthLastCheckedAt: toNullableIsoString(
            row.mcp_instance_health_last_checked_at,
          ),
          lastError: row.mcp_instance_last_error,
          lifecycleState: row.mcp_instance_lifecycle_state,
          scopeId: row.mcp_instance_scope_id,
          scopeType: row.mcp_instance_scope_type,
          toolCount: Number(row.mcp_instance_tool_count ?? 0),
          updatedAt: toIsoString(row.mcp_instance_updated_at ?? row.updated_at),
        }
      : null,
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
    usageSummary: {
      currency: row.product_usage_currency ?? 'USD',
      failureCount: Number(row.product_usage_failure_count ?? 0),
      lastOperation: row.product_usage_last_operation,
      lastUsedAt: toNullableIsoString(row.product_usage_last_used_at),
      monthStart: toIsoString(row.product_usage_month_start),
      successCount: Number(row.product_usage_success_count ?? 0),
      totalCalls: Number(row.product_usage_total_calls ?? 0),
      totalCost:
        row.slug === 'deep-water'
          ? 0
          : Number(row.product_usage_total_cost ?? 0),
      totalUnits: Number(row.product_usage_total_units ?? 0),
    },
  })
