import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  McpCatalogStatus,
} from '@nessie/schemas'

import type {
  CatalogView,
  McpCatalogEntryRow,
} from './mcp-catalog.js'

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
    where,
    orderBy: [{ status: 'asc' }, { label: 'asc' }],
  })
}
