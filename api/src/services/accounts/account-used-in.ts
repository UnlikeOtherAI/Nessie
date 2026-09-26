import type { PrismaClient } from '@prisma/client'
import { buildVisibleAgentWhere } from '@nessie/db'
import type { AccountKind, AccountUsedIn } from '@nessie/schemas'

import type { AccountViewer } from './account-sources.js'

/**
 * Used in (plan §6.7): what depends on an account, so revoking it is never
 * blind. Each list is the store's own relation — nothing is inferred:
 *
 * - a mailbox: the agents holding an access row;
 * - a Google account: the agents allowed to send without asking, and the
 *   automations that name the account as the mail they wait for;
 * - a ticket tool account: the projects whose boards sync through it;
 * - an AI plan: the agents pinned to it;
 * - a cloud browser account: the agents' own browsers on it, with how many
 *   sites each is signed in to.
 *
 * Only what the viewer may already see is named. The rest is counted in
 * `hiddenCount` and never named, so a revoke can say "and 2 more you cannot
 * see" without saying whose.
 */

type NamedAgent = { id: string; name: string }

const EMPTY: AccountUsedIn = { agents: [], automations: [], browsers: [], hiddenCount: 0, projects: [] }

/** Split agents into the ones the viewer may see (named) and a count of the rest. */
const visibleAgents = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  agentIds: readonly string[],
): Promise<{ hidden: number; visible: NamedAgent[] }> => {
  if (agentIds.length === 0) return { hidden: 0, visible: [] }
  const unique = [...new Set(agentIds)]
  const visible = await prisma.agent.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
    where: {
      AND: [
        { id: { in: unique } },
        buildVisibleAgentWhere({ organizationId: viewer.organizationId, userId: viewer.userId }),
      ],
    },
  })
  return { hidden: unique.length - visible.length, visible }
}

const mailboxUsedIn = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  connectionId: string,
): Promise<AccountUsedIn> => {
  const rows = await prisma.mailboxConnectionAgentAccess.findMany({
    select: { agentId: true },
    where: { connectionId, organizationId: viewer.organizationId },
  })
  const agents = await visibleAgents(prisma, viewer, rows.map((row) => row.agentId))
  return {
    ...EMPTY,
    agents: agents.visible.map((agent) => ({ ...agent, reason: 'may_use' as const })),
    hiddenCount: agents.hidden,
  }
}

const commsUsedIn = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  connectionId: string,
): Promise<AccountUsedIn> => {
  const now = new Date()
  const [grants, triggers] = await Promise.all([
    prisma.sendAuthorizationGrant.findMany({
      select: { agentId: true },
      where: {
        connectionId,
        organizationId: viewer.organizationId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    }),
    // An event automation that waits for mail names the account it listens
    // to in its filter; one with no filter listens to every account and is
    // not this account's dependent in particular.
    prisma.agentTrigger.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
      where: {
        agent: { organizationId: viewer.organizationId },
        config: { equals: connectionId, path: ['filter', 'connectionId'] },
        type: 'event',
      },
    }),
  ])
  const agents = await visibleAgents(prisma, viewer, grants.map((grant) => grant.agentId))
  // Automations are the owner's page (the trigger list's own gate), so only
  // an owner reads their names here.
  const automations = viewer.isOwner
    ? triggers.map((trigger) => ({ id: trigger.id, name: trigger.name ?? 'Untitled automation' }))
    : []
  return {
    ...EMPTY,
    agents: agents.visible.map((agent) => ({ ...agent, reason: 'acts_without_asking' as const })),
    automations,
    hiddenCount: agents.hidden + (viewer.isOwner ? 0 : triggers.length),
  }
}

const ticketsUsedIn = async (
  prisma: PrismaClient,
  connectionId: string,
  accessibleProjectIds: readonly string[] | 'all',
): Promise<AccountUsedIn> => {
  const sources = await prisma.boardSource.findMany({
    select: { project: { select: { id: true, name: true } } },
    where: { connectionId },
  })
  const byId = new Map(sources.map((source) => [source.project.id, source.project]))
  const projects = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  const visible = accessibleProjectIds === 'all'
    ? projects
    : projects.filter((project) => accessibleProjectIds.includes(project.id))
  return { ...EMPTY, hiddenCount: projects.length - visible.length, projects: visible }
}

const aiPlanUsedIn = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  subscriptionId: string,
): Promise<AccountUsedIn> => {
  const pinned = await prisma.agent.findMany({
    select: { id: true },
    where: { modelSubscriptionId: subscriptionId, organizationId: viewer.organizationId },
  })
  const agents = await visibleAgents(prisma, viewer, pinned.map((agent) => agent.id))
  return {
    ...EMPTY,
    agents: agents.visible.map((agent) => ({ ...agent, reason: 'runs_on' as const })),
    hiddenCount: agents.hidden,
  }
}

const browserUsedIn = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  connectionId: string,
): Promise<AccountUsedIn> => {
  const browsers = await prisma.agentBrowser.findMany({
    select: { _count: { select: { logins: true } }, agentId: true },
    where: { connectionId, organizationId: viewer.organizationId },
  })
  const agents = await visibleAgents(prisma, viewer, browsers.map((browser) => browser.agentId))
  const nameById = new Map(agents.visible.map((agent) => [agent.id, agent.name]))
  return {
    ...EMPTY,
    agents: agents.visible.map((agent) => ({ ...agent, reason: 'browser' as const })),
    browsers: browsers.flatMap((browser) => {
      const agentName = nameById.get(browser.agentId)
      return agentName
        ? [{ agentId: browser.agentId, agentName, signedInSites: browser._count.logins }]
        : []
    }),
    hiddenCount: agents.hidden,
  }
}

export const readAccountUsedIn = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  target: { id: string; kind: AccountKind },
  accessibleProjectIds: () => Promise<readonly string[] | 'all'>,
): Promise<AccountUsedIn> => {
  switch (target.kind) {
    case 'mailbox':
      return mailboxUsedIn(prisma, viewer, target.id)
    case 'comms':
      return commsUsedIn(prisma, viewer, target.id)
    case 'tickets':
      return ticketsUsedIn(prisma, target.id, await accessibleProjectIds())
    case 'ai-plan':
      return aiPlanUsedIn(prisma, viewer, target.id)
    case 'browser':
      return browserUsedIn(prisma, viewer, target.id)
    case 'app':
      // A person's own app reaches any agent in that person's own
      // conversations; nothing is pinned to it, so nothing depends on it.
      return EMPTY
  }
}
