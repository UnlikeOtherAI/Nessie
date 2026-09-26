import type { PrismaClient } from '@prisma/client'
import type { AccountKind, AccountListScope, AccountRecord } from '@nessie/schemas'

import {
  readAiPlanAccounts,
  readAppAccounts,
  readBrowserAccounts,
  readCommsAccounts,
  readMailboxAccounts,
  readTicketsAccounts,
  type AccountViewer,
} from './account-sources.js'

/**
 * Whose accounts a list reads (plan §10.1):
 *
 * - `me` — the viewer's own: Google, Microsoft and Slack accounts, personal
 *   mailboxes, ticket tool accounts, AI plans, a personal cloud browser
 *   account and personal app connections;
 * - `team:<id>` — that team's shared mailboxes and cloud browser account;
 * - `organisation` — the company's cloud browser account.
 *
 * Narrowing is the scope the address names, never the session's team. The
 * route decides who may read a team or the organisation; this only reads.
 */
export const listAccounts = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  scope: AccountListScope,
): Promise<AccountRecord[]> => {
  if (scope.kind === 'team') {
    const [mailboxes, browsers] = await Promise.all([
      readMailboxAccounts(prisma, viewer, { teamId: scope.teamId }),
      readBrowserAccounts(prisma, viewer, { scope: 'team', teamId: scope.teamId }),
    ])
    return [...mailboxes, ...browsers]
  }
  if (scope.kind === 'organisation') {
    return readBrowserAccounts(prisma, viewer, { scope: 'organization' })
  }
  const groups = await Promise.all([
    readCommsAccounts(prisma, viewer),
    readMailboxAccounts(prisma, viewer, { ownerUserId: viewer.userId }),
    readTicketsAccounts(prisma, viewer),
    readAiPlanAccounts(prisma, viewer),
    readBrowserAccounts(prisma, viewer, { scope: 'user', userId: viewer.userId }),
    readAppAccounts(prisma, viewer),
  ])
  return groups.flat()
}

/**
 * The team ids the viewer belongs to, for the one read a member may make of a
 * shared account: a team's shared mailbox is visible to that team's members
 * (as `listMailboxConnectionsForUser` has it), and managed by owners and
 * admins alone.
 */
const viewerTeamIds = async (prisma: PrismaClient, viewer: AccountViewer): Promise<string[]> =>
  (await prisma.teamMember.findMany({
    select: { teamId: true },
    where: {
      team: { project: { organizationId: viewer.organizationId } },
      userId: viewer.userId,
    },
  })).map((row) => row.teamId)

/**
 * One account, or null when the viewer may not see it — a refusal the route
 * answers exactly as it answers an id that does not exist, so a guessed id
 * learns nothing about somebody else's accounts.
 */
export const loadAccount = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  target: { id: string; kind: AccountKind },
): Promise<AccountRecord | null> => {
  const only = (rows: AccountRecord[]): AccountRecord | null => rows[0] ?? null
  switch (target.kind) {
    case 'comms':
      return only(await readCommsAccounts(prisma, viewer, target.id))
    case 'tickets':
      return only(await readTicketsAccounts(prisma, viewer, target.id))
    case 'ai-plan':
      return only(await readAiPlanAccounts(prisma, viewer, target.id))
    case 'app':
      return only(await readAppAccounts(prisma, viewer, target.id))
    case 'mailbox': {
      const sharedWhere = viewer.isManager
        ? { teamId: { not: null } }
        : { teamId: { in: await viewerTeamIds(prisma, viewer) } }
      return only(await readMailboxAccounts(prisma, viewer, {
        OR: [{ ownerUserId: viewer.userId }, sharedWhere],
        id: target.id,
      }))
    }
    case 'browser':
      return only(await readBrowserAccounts(prisma, viewer, {
        OR: [
          { scope: 'user', userId: viewer.userId },
          ...(viewer.isManager ? [{ scope: { not: 'user' as const } }] : []),
        ],
        id: target.id,
      }))
  }
}
