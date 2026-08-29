import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  McpCatalogStatus,
} from '@nessie/schemas'

import type {
  CatalogView,
  McpCatalogEntryRow,
} from './mcp-catalog.js'
import { catalogTenancyWhere } from './mcp-catalog-visibility.js'

/**
 * The connector list's column set, named rather than defaulted.
 *
 * It is exactly `McpCatalogEntryRow` — the shape `presentCatalogEntries`
 * spreads onto the wire — and deliberately nothing else. The App Store
 * dimension added to `mcp_catalog_entries` includes `upstream`, the raw
 * normalized registry record kept so a re-sync can diff without a second
 * fetch. A default `findMany` handed that snapshot to every member who opened
 * the Connectors page: multi-kilobyte per row, and it carries the *unsanitised*
 * upstream website and remote URLs that the App Store presenter withholds on
 * purpose. Naming the columns is the same discipline as
 * `STORE_CATALOG_SELECT` (`apps/app-presenter.ts`) — a column added to the
 * catalogue later cannot ride out on the wire by default.
 */
const CATALOG_LIST_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  label: true,
  description: true,
  protocol: true,
  authMethod: true,
  authConfig: true,
  defaultTransportConfig: true,
  iconUrl: true,
  vendor: true,
  sourceUrl: true,
  signature: true,
  status: true,
  visibility: true,
  locked: true,
  lockedAt: true,
  lockedBy: true,
  ownerUserId: true,
  submittedAt: true,
  reviewedAt: true,
  reviewedBy: true,
  rejectionReason: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const

/**
 * Ceiling on one connector-list response.
 *
 * Registry ingestion writes thousands of `public` + `published` rows, and the
 * store view is defined by exactly that pair — unbounded, it would grow with
 * the registry until a page load moved tens of megabytes. This is a safety
 * ceiling, not paging: the list is ordered, so the cap truncates the tail
 * deterministically rather than sampling. A catalogue that reaches it needs
 * server-side search on `/api/mcp/catalog` (the App Store's `/api/apps` route
 * is the pattern), not a bigger number here.
 */
export const CATALOG_LIST_LIMIT = 500

const listWhere = (
  actorContext: AuthorizedActionContext,
  view: CatalogView,
): Record<string, unknown> => {
  const ownerUserId = actorContext.actor.actorId
  switch (view) {
    case 'store':
      return { visibility: 'public', status: 'published' }
    case 'mine':
      return { ownerUserId }
    case 'queue':
      return { status: 'pending_approval', visibility: 'public' }
    case 'all':
      return {}
  }
}

export const listCatalogEntries = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  filters: { view?: CatalogView; status?: McpCatalogStatus } = {},
): Promise<McpCatalogEntryRow[]> => {
  const view = filters.view ?? 'store'
  const where = listWhere(actorContext, view)
  // A caller-supplied status sub-filter only narrows the management views.
  // Store and queue pin status so a filter can never expose the review queue.
  if (filters.status && (view === 'mine' || view === 'all')) {
    where.status = filters.status
  }
  return prisma.mcpCatalogEntry.findMany({
    // Every view is tenancy-floored: `all` and `queue` would otherwise return
    // other tenants' rows, and the public store is readable by everyone.
    where: { ...where, ...catalogTenancyWhere(actorContext) },
    select: CATALOG_LIST_SELECT,
    orderBy: [{ status: 'asc' }, { label: 'asc' }],
    take: CATALOG_LIST_LIMIT,
  })
}
