import type { Prisma, PrismaClient } from '@prisma/client'
import type { AppDetailRecord, AuthorizedActionContext } from '@nessie/schemas'

import { listInstancesVisibleToUser, resolveMcpUserAccess } from '../mcp-instances.js'
import {
  listAgentsWithAppAccess,
  type AppAccessRegistryRow,
} from './app-agent-access.js'
import { deriveConnectionStatus, presentAppConnection } from './app-connections.js'
import { canManageAppConnectionScope } from './app-connection-management.js'
import { loadUnreachableAppIds } from './app-health.js'
import {
  presentAppCapabilities,
  presentAppDetail,
  STORE_CATALOG_SELECT,
} from './app-presenter.js'
import { storeCatalogWhere } from './app-store-visibility.js'

/**
 * One app, addressed by the slug in `/apps/:slug`.
 *
 * The same visibility gate as the list, so an app a caller cannot see in the
 * store is not reachable by guessing its slug either.
 */

/** Canonical lowercase-or-uppercase UUID, the shape `McpCatalogEntry.id` takes. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `slug` is nullable by design — a name carrying no `[a-z0-9]` character
 * slugifies to nothing, and the store migration also nulled the few slugs that
 * collided rather than aborting. Those apps are listed with `slug: null`, so
 * their cards link to `/apps/<id>`; matching on the slug column alone would
 * 404 the very rows the null was supposed to keep reachable.
 *
 * The id arm is gated on the UUID shape because Postgres rejects a malformed
 * uuid comparison outright — an arbitrary slug must not become a 500.
 */
const appIdentityWhere = (
  identifier: string,
): Prisma.McpCatalogEntryWhereInput =>
  UUID_PATTERN.test(identifier)
    ? { OR: [{ slug: identifier }, { id: identifier }] }
    : { slug: identifier }

type ProjectionRow = AppAccessRegistryRow & {
  label: string
  description: string
}

/**
 * Every tool this app's connected accounts project, review state included:
 * the Capabilities tab answers "what can this app do", which is true of a
 * projection whether or not an owner has approved it for use yet. Whether an
 * agent may *call* one is a separate question, and `listAgentsWithAppAccess`
 * is where it gets asked.
 */
const loadProjections = async (
  prisma: PrismaClient,
  organizationId: string,
  instanceIds: readonly string[],
): Promise<ProjectionRow[]> => {
  if (instanceIds.length === 0) return []
  return prisma.toolRegistryEntry.findMany({
    where: {
      organizationId,
      handlerKind: 'mcp',
      mcpInstanceId: { in: [...instanceIds] },
      enabled: true,
    },
    select: {
      description: true,
      id: true,
      inputSchema: true,
      mcpInstanceId: true,
      enabled: true,
      status: true,
      metadata: true,
      outputSchema: true,
      toolId: true,
      transportConfig: true,
      label: true,
    },
  })
}

export const getStoreApp = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  identifier: string,
): Promise<AppDetailRecord | null> => {
  const organizationId = actorContext.tenant.organizationId
  const row = await prisma.mcpCatalogEntry.findFirst({
    // `AND`ed rather than spread: `storeCatalogWhere` already owns a top-level
    // `OR`, and merging two objects that both carry one silently drops a gate.
    where: { AND: [appIdentityWhere(identifier), storeCatalogWhere(actorContext)] },
    select: STORE_CATALOG_SELECT,
  })
  if (!row) return null

  // Narrowed after the fact rather than by a `catalogEntryId` filter, so the
  // one entitlement predicate decides which connections exist here exactly as
  // it does on the grid — the counts on the two surfaces cannot drift.
  const access = await resolveMcpUserAccess(
    prisma,
    organizationId,
    actorContext.actor.actorId,
  )
  const visibleInstances = await listInstancesVisibleToUser(
    prisma,
    organizationId,
    actorContext.actor.actorId,
    access,
  )
  const instances = visibleInstances.filter(
    (instance) => instance.catalogEntryId === row.id,
  )
  const [projections, unreachable] = await Promise.all([
    loadProjections(prisma, organizationId, instances.map((i) => i.id)),
    loadUnreachableAppIds(prisma, [row.id]),
  ])
  const appName = row.displayName ?? row.label

  return presentAppDetail(row, {
    connectionStatuses: instances.map((instance) =>
      deriveConnectionStatus(instance.lifecycleState),
    ),
    serverUnreachable: unreachable.has(row.id),
    capabilities: presentAppCapabilities(projections),
    connections: await Promise.all(instances.map(async (instance) =>
      presentAppConnection(
        instance,
        appName,
        await canManageAppConnectionScope(
          { access, actorContext, prisma },
          instance.scopeType,
          instance.scopeId,
        ),
      ),
    )),
    // The caller's own context, not just the tenant id: which agents this
    // names is an entitlement question, answered by the same rule
    // `GET /api/agents` answers it with.
    agentsWithAccess: await listAgentsWithAppAccess(
      prisma,
      actorContext,
      instances,
      projections,
    ),
  })
}
