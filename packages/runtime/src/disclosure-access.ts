import type { PrismaClient } from '@prisma/client'
import { listVisibleAgentIdsForUser } from '@nessie/db'
import {
  viewerSatisfiesBasis,
  type BasisScopeRow,
  type DisclosureViewer,
} from './disclosure-predicate.js'

/** The small Prisma surface shared by disclosure readers and push delivery. */
export type DisclosureAccessPrisma = Pick<PrismaClient,
  | 'agent'
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

  // Membership rows are intentionally retained after deactivation for audit
  // history. Resolve the live organization membership first so those retained
  // channel/project/team rows cannot keep a deactivated viewer or grantor
  // entitled to a restricted reply.
  const orgMembership = await prisma.organizationMember.findFirst({
    where: { deactivatedAt: null, organizationId, userId },
    select: { id: true },
  })
  if (!orgMembership) return { kind: 'autonomous' }

  const [channels, teams, projects, visibleAgentIds] = await Promise.all([
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
    listVisibleAgentIdsForUser(prisma, { organizationId, userId }),
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

const liveGrantFilter = (now: Date) => ({
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
})

type MessageGrantRow = { grantedByUserId: string; messageId: string }
type ScopeGrantRow = {
  agentId: string
  grantedByUserId: string
  sourceScopeId: string
  sourceScopeType: string
}

/**
 * Every grant that could lift a restriction for this viewer, over any number of
 * messages, in two queries.
 *
 * `messageIds` is filtered to the messages that actually carry a basis before
 * it gets here: `message_id` is a uuid column, so an empty list must be skipped
 * rather than queried with a placeholder — an empty string reaches Postgres as
 * an invalid uuid and throws, which would turn "is this readable?" into a 500.
 */
const fetchGrantRows = async (
  prisma: DisclosureAccessPrisma,
  input: {
    agentIds: readonly string[]
    channelId: string
    messageIds: readonly string[]
    organizationId: string
    viewerChannelIds: readonly string[]
    viewerUserId: string
  },
): Promise<{ messageGrants: MessageGrantRow[]; scopeGrants: ScopeGrantRow[] }> => {
  const now = new Date()
  const [messageGrants, scopeGrants] = await Promise.all([
    input.messageIds.length > 0
      ? prisma.disclosureGrant.findMany({
        where: {
          messageId: { in: [...input.messageIds] },
          organizationId: input.organizationId,
          ...liveGrantFilter(now),
          OR: [
            { audienceKind: 'user', audienceId: input.viewerUserId },
            { audienceKind: 'channel', audienceId: { in: [...input.viewerChannelIds] } },
          ],
        },
        select: { grantedByUserId: true, messageId: true },
      })
      : Promise.resolve([]),
    input.agentIds.length > 0
      ? prisma.scopeDisclosureGrant.findMany({
        where: {
          organizationId: input.organizationId,
          destinationChannelId: input.channelId,
          agentId: { in: [...input.agentIds] },
          ...liveGrantFilter(now),
        },
        select: {
          agentId: true,
          grantedByUserId: true,
          sourceScopeId: true,
          sourceScopeType: true,
        },
      })
      : Promise.resolve([]),
  ])
  return { messageGrants, scopeGrants }
}

/**
 * A grant is only as good as its granter's current access, so each granter is
 * re-resolved here — once per distinct granter rather than once per grant row,
 * which is what makes a page of restricted messages cost a bounded number of
 * queries instead of one resolution per row.
 */
const resolveGranterViewers = async (
  prisma: DisclosureAccessPrisma,
  organizationId: string,
  granterIds: readonly string[],
): Promise<Map<string, DisclosureViewer>> => {
  const distinct = [...new Set(granterIds)]
  const resolved = await Promise.all(
    distinct.map(async (userId) =>
      [userId, await resolveDisclosureViewer(prisma, organizationId, userId)] as const),
  )
  return new Map(resolved)
}

/** The scope keys one basis gains from grant rows already fetched and re-checked. */
const grantedKeysForBasis = (input: {
  basis: readonly BasisScopeRow[]
  granterViewers: Map<string, DisclosureViewer>
  messageGrants: readonly MessageGrantRow[]
  scopeGrants: readonly ScopeGrantRow[]
}): Set<string> => {
  const granted = new Set<string>()
  for (const grant of input.messageGrants) {
    const granter = input.granterViewers.get(grant.grantedByUserId)
    if (granter && viewerSatisfiesBasis(input.basis, granter)) {
      for (const scope of input.basis) granted.add(`${scope.scopeType}:${scope.scopeId}`)
    }
  }
  for (const grant of input.scopeGrants) {
    const granter = input.granterViewers.get(grant.grantedByUserId)
    if (
      granter
      && viewerSatisfiesBasis(
        [{ scopeId: grant.sourceScopeId, scopeType: grant.sourceScopeType }],
        granter,
      )
    ) {
      granted.add(`${grant.sourceScopeType}:${grant.sourceScopeId}`)
    }
  }
  return granted
}

/** One restricted message as the grant resolver needs to see it. */
export type DisclosureGrantSubject = {
  agentId: string | null
  basis: readonly BasisScopeRow[]
  messageId: string
}

/**
 * Scope keys a viewer holds through a still-valid disclosure grant, for a whole
 * page of messages at once, keyed by message id.
 *
 * The per-message form below is this same resolution over one subject. Read
 * paths that withhold more than one row — a channel page, a reply
 * conversation's read acknowledgement — must use this one: resolving grants a
 * row at a time cost two round trips per withheld row, in series, on the two
 * most-executed reads in the product.
 */
export const resolveGrantedScopeKeysForMessages = async (
  prisma: DisclosureAccessPrisma,
  input: {
    channelId: string
    messages: readonly DisclosureGrantSubject[]
    organizationId: string
    viewerChannelIds: readonly string[]
    viewerUserId: string | null
  },
): Promise<Map<string, Set<string>>> => {
  const resolved = new Map<string, Set<string>>()
  const restricted = input.viewerUserId
    ? input.messages.filter((message) => message.basis.length > 0)
    : []
  for (const message of input.messages) resolved.set(message.messageId, new Set<string>())
  if (restricted.length === 0 || !input.viewerUserId) return resolved

  const { messageGrants, scopeGrants } = await fetchGrantRows(prisma, {
    agentIds: [...new Set(restricted.flatMap((message) =>
      message.agentId ? [message.agentId] : []))],
    channelId: input.channelId,
    messageIds: restricted.map((message) => message.messageId),
    organizationId: input.organizationId,
    viewerChannelIds: input.viewerChannelIds,
    viewerUserId: input.viewerUserId,
  })
  const granterViewers = await resolveGranterViewers(
    prisma,
    input.organizationId,
    [
      ...messageGrants.map((grant) => grant.grantedByUserId),
      ...scopeGrants.map((grant) => grant.grantedByUserId),
    ],
  )

  for (const message of restricted) {
    resolved.set(message.messageId, grantedKeysForBasis({
      basis: message.basis,
      granterViewers,
      messageGrants: messageGrants.filter((grant) => grant.messageId === message.messageId),
      scopeGrants: message.agentId === null
        ? []
        : scopeGrants.filter((grant) => grant.agentId === message.agentId),
    }))
  }
  return resolved
}

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
    /**
     * The message the basis is attached to, or null for a basis that belongs to
     * no single message — a run's own `RunBasisScope` ledger. Per-message grants
     * simply cannot match in that case, which is the correct reading: sharing
     * one reply does not publish the reasoning of every run in the room.
     */
    messageId: string | null
    organizationId: string
    viewerChannelIds: readonly string[]
    viewerUserId: string | null
  },
): Promise<Set<string>> => {
  if (input.basis.length === 0 || !input.viewerUserId) return new Set<string>()

  const { messageGrants, scopeGrants } = await fetchGrantRows(prisma, {
    agentIds: input.agentId ? [input.agentId] : [],
    channelId: input.channelId,
    messageIds: input.messageId ? [input.messageId] : [],
    organizationId: input.organizationId,
    viewerChannelIds: input.viewerChannelIds,
    viewerUserId: input.viewerUserId,
  })
  const granterViewers = await resolveGranterViewers(
    prisma,
    input.organizationId,
    [
      ...messageGrants.map((grant) => grant.grantedByUserId),
      ...scopeGrants.map((grant) => grant.grantedByUserId),
    ],
  )
  return grantedKeysForBasis({ basis: input.basis, granterViewers, messageGrants, scopeGrants })
}

/** Revalidates whether a user may see a message's restricted reply at send time. */
export const canUserReadDisclosureBasis = async (
  prisma: DisclosureAccessPrisma,
  input: {
    agentId: string | null
    basis: readonly BasisScopeRow[]
    channelId: string
    /** Null for a run-level basis; see `resolveGrantedDisclosureScopeKeys`. */
    messageId: string | null
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
