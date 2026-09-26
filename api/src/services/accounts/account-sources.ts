import type { Prisma, PrismaClient } from '@prisma/client'
import { isManagedIntegrationCatalogEntry } from '@nessie/mcp-manage'
import { requireSubscriptionAdapter } from '@nessie/model-subscriptions'
import { GoogleCapabilityIdSchema, type AccountRecord, type GoogleCapabilityId } from '@nessie/schemas'
import { listOwnedCommsConnections } from '@nessie/team-admin'

import {
  projectAiPlanAccount,
  projectAppAccount,
  projectBrowserAccount,
  projectCommsAccount,
  projectMailboxAccount,
  projectTicketsAccount,
} from './account-projection.js'

/**
 * The reads behind the accounts projection, one per store. Each takes the
 * store's own visibility rule as a `where` the caller builds from the viewer,
 * and hands its rows to the matching row builder — so the list, an account's
 * page and Check access read an account through exactly the same query.
 *
 * Nothing here selects a credential column or joins a credential table.
 */

/** Who is reading. Roles are the request's live ones (`requireActorContext`). */
export type AccountViewer = {
  isManager: boolean
  isOwner: boolean
  organizationId: string
  userId: string
}

const stringArray = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const capabilityIds = (value: Prisma.JsonValue): GoogleCapabilityId[] =>
  stringArray(value).filter(
    (entry): entry is GoogleCapabilityId => GoogleCapabilityIdSchema.safeParse(entry).success,
  )

// ─── Google, Microsoft, Slack — always the viewer's own ─────────────────────

export const readCommsAccounts = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  onlyId?: string,
): Promise<AccountRecord[]> => {
  // The same listing the comms routes use, so a disconnected connection (whose
  // row is kept) appears here exactly as it does there.
  const rows = await listOwnedCommsConnections(prisma, {
    organizationId: viewer.organizationId,
    userId: viewer.userId,
  })
  return rows
    .filter((row) => !onlyId || row.connection.id === onlyId)
    .map(({ connection }) => projectCommsAccount({
      createdAt: connection.createdAt,
      disabledCapabilities: capabilityIds(connection.disabledCapabilities),
      externalTenantId: connection.externalTenantId,
      externalUserId: connection.externalUserId,
      grantedScopes: stringArray(connection.grantedScopes),
      id: connection.id,
      lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
      ownerUserId: connection.ownerUserId,
      provider: connection.provider,
      status: connection.status,
    }))
}

// ─── Another email provider — personal or a team's shared mailbox ───────────

export const readMailboxAccounts = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  where: Prisma.MailboxConnectionWhereInput,
): Promise<AccountRecord[]> => {
  const rows = await prisma.mailboxConnection.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      address: true,
      agentAccess: { select: { agentId: true } },
      createdAt: true,
      id: true,
      label: true,
      lastVerifiedAt: true,
      ownerUserId: true,
      status: true,
      team: { select: { id: true, name: true } },
    },
    where: { ...where, organizationId: viewer.organizationId },
  })
  return rows.map((row) => projectMailboxAccount(
    {
      address: row.address,
      agentIds: row.agentAccess.map((access) => access.agentId),
      createdAt: row.createdAt,
      id: row.id,
      label: row.label,
      lastVerifiedAt: row.lastVerifiedAt,
      ownerUserId: row.ownerUserId,
      status: row.status,
      team: row.team,
    },
    {
      // The mailbox routes' own rule (`loadManageableMailboxConnection`): the
      // person who connected a personal one, or an owner or admin for a
      // shared one — never anyone else's personal mailbox.
      canManage: row.ownerUserId === viewer.userId || (row.team !== null && viewer.isManager),
      userId: viewer.userId,
    },
  ))
}

// ─── Ticket and code tools — always the viewer's own ────────────────────────

export const readTicketsAccounts = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  onlyId?: string,
): Promise<AccountRecord[]> => {
  const rows = await prisma.boardSourceConnection.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      authMethod: true,
      createdAt: true,
      externalAccountId: true,
      externalTenantId: true,
      id: true,
      lastVerifiedAt: true,
      ownerUserId: true,
      provider: true,
      status: true,
    },
    where: {
      organizationId: viewer.organizationId,
      ownerUserId: viewer.userId,
      ...(onlyId ? { id: onlyId } : {}),
    },
  })
  return rows.map((row) => projectTicketsAccount(row))
}

// ─── AI plans — always the viewer's own ─────────────────────────────────────

export const readAiPlanAccounts = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  onlyId?: string,
): Promise<AccountRecord[]> => {
  const rows = await prisma.modelSubscription.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      _count: { select: { agents: true } },
      accountLabel: true,
      createdAt: true,
      healthReason: true,
      id: true,
      lastUsedAt: true,
      provider: true,
      status: true,
      userId: true,
    },
    where: {
      organizationId: viewer.organizationId,
      userId: viewer.userId,
      ...(onlyId ? { id: onlyId } : {}),
    },
  })
  return rows.map((row) => {
    const adapter = requireSubscriptionAdapter(row.provider)
    return projectAiPlanAccount({
      accountLabel: row.accountLabel,
      createdAt: row.createdAt,
      healthReason: row.healthReason,
      id: row.id,
      lastUsedAt: row.lastUsedAt,
      pinnedAgentCount: row._count.agents,
      provider: adapter.key,
      serviceName: adapter.displayName,
      status: row.status,
      userId: row.userId,
    })
  })
}

// ─── Cloud browser accounts, at every level ─────────────────────────────────

export const readBrowserAccounts = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  where: Prisma.CloudBrowserConnectionWhereInput,
): Promise<AccountRecord[]> => {
  // Read here rather than through `listCloudBrowserConnections`, which lists
  // the organisation's account and the caller's own and never a team's — the
  // gap Company connections at a team's scope could not show before.
  const rows = await prisma.cloudBrowserConnection.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      healthCheckedAt: true,
      healthReason: true,
      id: true,
      scope: true,
      status: true,
      teamId: true,
      userId: true,
    },
    where: { ...where, organizationId: viewer.organizationId },
  })
  const teamIds = [...new Set(rows.flatMap((row) => (row.teamId ? [row.teamId] : [])))]
  const teams = teamIds.length === 0
    ? []
    : await prisma.team.findMany({
        select: { id: true, name: true },
        where: { id: { in: teamIds }, project: { organizationId: viewer.organizationId } },
      })
  const teamById = new Map(teams.map((team) => [team.id, team]))
  return rows.map((row) => projectBrowserAccount(
    {
      createdAt: row.createdAt,
      healthCheckedAt: row.healthCheckedAt,
      healthReason: row.healthReason,
      id: row.id,
      scope: row.scope,
      status: row.status,
      team: row.teamId ? teamById.get(row.teamId) ?? null : null,
      userId: row.userId,
    },
    { isOwner: viewer.isOwner, userId: viewer.userId },
  ))
}

// ─── A person's own app connections ─────────────────────────────────────────

export const readAppAccounts = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  onlyId?: string,
): Promise<AccountRecord[]> => {
  const rows = await prisma.mcpServerInstance.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      _count: { select: { toolRegistryEntries: { where: { enabled: true } } } },
      catalogEntry: { select: { displayName: true, id: true, label: true, slug: true } },
      createdAt: true,
      healthLastCheckedAt: true,
      id: true,
      lifecycleState: true,
      scopeId: true,
    },
    where: {
      organizationId: viewer.organizationId,
      scopeId: viewer.userId,
      scopeType: 'user',
      ...(onlyId ? { id: onlyId } : {}),
    },
  })
  return Promise.all(rows.map(async (row) => projectAppAccount({
    appName: row.catalogEntry.displayName ?? row.catalogEntry.label,
    capabilityCount: row._count.toolRegistryEntries,
    createdAt: row.createdAt,
    healthLastCheckedAt: row.healthLastCheckedAt,
    id: row.id,
    lifecycleState: row.lifecycleState,
    managed: await isManagedIntegrationCatalogEntry(prisma, row.catalogEntry.id),
    slug: row.catalogEntry.slug,
    userId: row.scopeId,
  })))
}
