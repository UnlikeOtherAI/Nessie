import type { PrismaClient } from '@prisma/client'
import {
  viewerSatisfiesBasis,
  type BasisScopeRow,
  type DisclosureViewer,
} from './disclosure-predicate.js'

/** The small Prisma surface shared by disclosure readers and push delivery. */
export type DisclosureAccessPrisma = Pick<PrismaClient,
  | 'channelMember'
  | 'disclosureGrant'
  | 'organizationMember'
  | 'projectMember'
  | 'scopeDisclosureGrant'
  | 'teamMember'>

/**
 * Resolves a person's live reach for disclosure reads. This is shared by the
 * API feed and worker delivery paths so a revoked source cannot remain visible
 * in a notification after the feed would withhold it.
 */
export const resolveDisclosureViewer = async (
  prisma: DisclosureAccessPrisma,
  organizationId: string,
  userId: string | null | undefined,
): Promise<DisclosureViewer> => {
  if (!userId) return { kind: 'autonomous' }

  const [channels, teams, projects, orgMembership] = await Promise.all([
    prisma.channelMember.findMany({
      where: { userId, channel: { organizationId } },
      select: { channelId: true },
    }),
    prisma.teamMember.findMany({
      where: { userId, team: { project: { organizationId } } },
      select: { teamId: true },
    }),
    prisma.projectMember.findMany({
      where: { userId, project: { organizationId } },
      select: { projectId: true },
    }),
    prisma.organizationMember.findFirst({
      where: { userId, organizationId },
      select: { id: true },
    }),
  ])

  return {
    kind: 'user',
    scopes: [
      { scopeId: userId, scopeType: 'user' },
      ...channels.map((row) => ({ scopeId: row.channelId, scopeType: 'channel' })),
      ...teams.map((row) => ({ scopeId: row.teamId, scopeType: 'team' })),
      ...projects.map((row) => ({ scopeId: row.projectId, scopeType: 'project' })),
      ...(orgMembership ? [{ scopeId: organizationId, scopeType: 'organization' }] : []),
    ],
    userId,
  }
}

const liveGrantFilter = (now: Date) => ({
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
})

/**
 * Scope keys a viewer holds through a still-valid disclosure grant. Grant
 * granters are rechecked at delivery time, keeping revocation immediate.
 */
export const resolveGrantedDisclosureScopeKeys = async (
  prisma: DisclosureAccessPrisma,
  input: {
    agentId: string | null
    basis: readonly BasisScopeRow[]
    channelId: string
    messageId: string
    organizationId: string
    viewerChannelIds: readonly string[]
    viewerUserId: string | null
  },
): Promise<Set<string>> => {
  const granted = new Set<string>()
  if (input.basis.length === 0 || !input.viewerUserId) return granted

  const [messageGrants, scopeGrants] = await Promise.all([
    prisma.disclosureGrant.findMany({
      where: {
        messageId: input.messageId,
        organizationId: input.organizationId,
        ...liveGrantFilter(new Date()),
        OR: [
          { audienceKind: 'user', audienceId: input.viewerUserId },
          { audienceKind: 'channel', audienceId: { in: [...input.viewerChannelIds] } },
        ],
      },
      select: { grantedByUserId: true },
    }),
    input.agentId
      ? prisma.scopeDisclosureGrant.findMany({
        where: {
          organizationId: input.organizationId,
          destinationChannelId: input.channelId,
          agentId: input.agentId,
          ...liveGrantFilter(new Date()),
        },
        select: { sourceScopeId: true, sourceScopeType: true, grantedByUserId: true },
      })
      : Promise.resolve([]),
  ])

  for (const grant of messageGrants) {
    const granter = await resolveDisclosureViewer(
      prisma,
      input.organizationId,
      grant.grantedByUserId,
    )
    if (viewerSatisfiesBasis(input.basis, granter)) {
      for (const scope of input.basis) granted.add(`${scope.scopeType}:${scope.scopeId}`)
    }
  }

  for (const grant of scopeGrants) {
    const granter = await resolveDisclosureViewer(
      prisma,
      input.organizationId,
      grant.grantedByUserId,
    )
    if (viewerSatisfiesBasis([
      { scopeId: grant.sourceScopeId, scopeType: grant.sourceScopeType },
    ], granter)) {
      granted.add(`${grant.sourceScopeType}:${grant.sourceScopeId}`)
    }
  }

  return granted
}

/** Revalidates whether a user may see a message's restricted reply at send time. */
export const canUserReadDisclosureBasis = async (
  prisma: DisclosureAccessPrisma,
  input: {
    agentId: string | null
    basis: readonly BasisScopeRow[]
    channelId: string
    messageId: string
    organizationId: string
    userId: string
  },
): Promise<boolean> => {
  const viewer = await resolveDisclosureViewer(prisma, input.organizationId, input.userId)
  if (viewer.kind !== 'user') return false
  if (viewerSatisfiesBasis(input.basis, viewer)) return true

  const granted = await resolveGrantedDisclosureScopeKeys(prisma, {
    agentId: input.agentId,
    basis: input.basis,
    channelId: input.channelId,
    messageId: input.messageId,
    organizationId: input.organizationId,
    viewerChannelIds: viewer.scopes
      .filter((scope) => scope.scopeType === 'channel')
      .map((scope) => scope.scopeId),
    viewerUserId: viewer.userId,
  })
  return viewerSatisfiesBasis(input.basis, viewer, granted)
}
