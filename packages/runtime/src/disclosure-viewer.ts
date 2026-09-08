import type { PrismaClient } from '@prisma/client'
import { listVisibleAgentIdsForUser } from '@nessie/db'
import type { UoaSessionIdentity } from '@nessie/schemas'
import type { DisclosureViewer } from './disclosure-predicate.js'
import {
  resolveLiveEntitlements,
  type LiveEntitlements,
} from './uoa-live-entitlements.js'

/** The small Prisma surface shared by disclosure readers and push delivery. */
export type DisclosureAccessPrisma = Pick<PrismaClient,
  | 'agent'
  | 'channel'
  | 'channelMember'
  | 'disclosureGrant'
  | 'organization'
  | 'organizationMember'
  | 'productAccountLink'
  | 'projectMember'
  | 'scopeDisclosureGrant'
  | 'team'
  | 'teamMember'>

export type DisclosureViewerAuthority = {
  agentId?: string
  allowStoredUoaIdentity?: boolean
  uoaIdentity?: UoaSessionIdentity
}

/** An agent has only its product bindings and configured hierarchy. */
const agentScopes = async (
  prisma: DisclosureAccessPrisma,
  organizationId: string,
  agentId: string,
): Promise<DisclosureViewer> => {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId },
    select: {
      id: true,
      projectId: true,
      teamId: true,
      bindings: { select: { channelId: true } },
    },
  })
  if (!agent) return { kind: 'autonomous' }
  return {
    agentId,
    kind: 'agent',
    scopes: [
      ...agent.bindings.map((binding) => ({ scopeId: binding.channelId, scopeType: 'channel' })),
      ...(agent.teamId ? [{ scopeId: agent.teamId, scopeType: 'team' }] : []),
      ...(agent.projectId ? [{ scopeId: agent.projectId, scopeType: 'project' }] : []),
      { scopeId: organizationId, scopeType: 'organization' },
      { scopeId: agent.id, scopeType: 'agent' },
    ],
  }
}

const userScopes = async (
  prisma: DisclosureAccessPrisma,
  organizationId: string,
  userId: string,
  entitlements: LiveEntitlements,
): Promise<DisclosureViewer> => {
  if (entitlements.kind === 'denied') return { kind: 'autonomous' }
  const uoa = entitlements.kind === 'uoa'
  const [channels, teams, projects, visibleAgentIds] = await Promise.all([
    prisma.channelMember.findMany({
      where: {
        userId,
        channel: { organizationId },
      },
      select: { channelId: true },
    }),
    uoa
      ? Promise.resolve(entitlements.teamIds.map((teamId) => ({ teamId })))
      : prisma.teamMember.findMany({
        where: { userId, team: { project: { organizationId } } },
        select: { teamId: true },
      }),
    prisma.projectMember.findMany({
      where: {
        userId,
        project: { organizationId },
      },
      select: { projectId: true },
    }),
    listVisibleAgentIdsForUser(prisma, {
      organizationId,
      userId,
      ...(uoa ? { uoaMembershipVerified: true } : {}),
    }),
  ])
  return {
    kind: 'user',
    scopes: [
      { scopeId: userId, scopeType: 'user' },
      ...channels.map((row) => ({ scopeId: row.channelId, scopeType: 'channel' })),
      ...teams.map((row) => ({ scopeId: row.teamId, scopeType: 'team' })),
      ...projects.map((row) => ({ scopeId: row.projectId, scopeType: 'project' })),
      ...visibleAgentIds.map((scopeId) => ({ scopeId, scopeType: 'agent' })),
      { scopeId: organizationId, scopeType: 'organization' },
    ],
    userId,
  }
}

/** Resolves fresh human reach or explicit autonomous-agent product reach. */
export const resolveDisclosureViewer = async (
  prisma: DisclosureAccessPrisma,
  organizationId: string,
  userId: string | null | undefined,
  authority: DisclosureViewerAuthority = {},
): Promise<DisclosureViewer> => {
  if (!userId) {
    return authority.agentId
      ? agentScopes(prisma, organizationId, authority.agentId)
      : { kind: 'autonomous' }
  }
  const entitlements = await resolveLiveEntitlements(prisma, {
    allowStoredIdentity: authority.allowStoredUoaIdentity,
    organizationId,
    uoaIdentity: authority.uoaIdentity,
    userId,
  })
  return userScopes(prisma, organizationId, userId, entitlements)
}
