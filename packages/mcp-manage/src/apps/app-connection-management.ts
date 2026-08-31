import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, McpServerScopeType } from '@nessie/schemas'

import {
  canManageInstanceScope,
  resolveMcpUserAccess,
  type McpUserAccess,
} from '../mcp-instances.js'

type AppConnectionManagementContext = {
  actorContext: AuthorizedActionContext
  /** A detail read can share the access it already resolved for visibility. */
  access?: McpUserAccess
  prisma: PrismaClient
}

/**
 * The one authorisation predicate for an account-management control on
 * `/apps`. It reads the live membership row, matching the disconnect write, so
 * a row never offers an action the route will reject.
 */
export const canManageAppConnectionScope = async (
  context: AppConnectionManagementContext,
  scopeType: McpServerScopeType,
  scopeId: string,
): Promise<boolean> => {
  const { actorContext, prisma } = context
  const access = context.access ?? await resolveMcpUserAccess(
    prisma,
    actorContext.tenant.organizationId,
    actorContext.actor.actorId,
  )
  return canManageInstanceScope(access, actorContext.actor.actorId, scopeType, scopeId)
}
