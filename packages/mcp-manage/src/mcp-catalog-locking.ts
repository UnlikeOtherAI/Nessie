import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  MCP_CATALOG_ERROR_CODES,
  McpCatalogError,
  getAccessibleCatalogEntry,
  isAdminRole,
  type McpCatalogEntryRow,
} from './mcp-catalog.js'
import { assertCatalogLifecycleIsUserManaged } from './managed-products.js'

/**
 * Lock/unlock an entry for member self-service (owner or org admin only).
 * A locked entry cannot be installed by members, but existing instances keep
 * working until removed.
 */
export const setCatalogEntryLocked = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
  locked: boolean,
): Promise<McpCatalogEntryRow | null> => {
  if (!isAdminRole(actorContext)) {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.FORBIDDEN,
      'Only organisation owners/admins can lock or unlock connectors',
    )
  }
  const existing = await getAccessibleCatalogEntry(prisma, actorContext, id)
  if (!existing) return null
  await assertCatalogLifecycleIsUserManaged(prisma, id)
  if (existing.locked === locked) return existing
  return prisma.mcpCatalogEntry.update({
    where: { id },
    data: {
      locked,
      lockedAt: locked ? new Date() : null,
      lockedBy: locked ? actorContext.actor.actorId : null,
    },
  })
}
