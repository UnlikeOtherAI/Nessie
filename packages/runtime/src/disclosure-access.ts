import {
  viewerSatisfiesBasis,
  type BasisScopeRow,
  type DisclosureViewer,
} from './disclosure-predicate.js'
import type { UoaSessionIdentity } from '@nessie/schemas'
import {
  resolveDisclosureViewer,
  type DisclosureAccessPrisma,
} from './disclosure-viewer.js'
export {
  resolveDisclosureViewer,
  type DisclosureAccessPrisma,
  type DisclosureViewerAuthority,
} from './disclosure-viewer.js'

const liveGrantFilter = (now: Date) => ({
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
})

type MessageGrantRow = { grantedByUserId: string; messageId: string }
export type DisclosureSource = {
  sourceAuthorUserId: string | null
  sourceChannelId: string
}

type ScopeGrantRow = {
  agentId: string
  grantedByUserId: string
  sourceScopeId: string
  sourceScopeType: string
}

/**
 * Every grant that could lift a restriction for this viewer, over any number of
 * messages, in two grant queries. Legacy channel-basis checks may make one
 * additional bounded channel lookup before these rows are fetched.
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
          revokedAt: null,
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            { OR: [
              { audienceKind: 'user', audienceId: input.viewerUserId },
              { audienceKind: 'channel', audienceId: { in: [...input.viewerChannelIds] } },
            ] },
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
 * A public destination does not require a ChannelMember row. A grant to that
 * exact channel therefore reaches every active reader of its thread, while a
 * private destination remains limited to its explicit member scopes.
 */
const readableGrantAudienceChannelIds = async (
  prisma: DisclosureAccessPrisma,
  input: {
    channelId: string
    organizationId: string
    viewerChannelIds: readonly string[]
  },
): Promise<readonly string[]> => {
  if (input.viewerChannelIds.includes(input.channelId)) return input.viewerChannelIds
  const destination = await prisma.channel.findFirst({
    where: {
      id: input.channelId,
      organizationId: input.organizationId,
      visibility: 'public',
    },
    select: { id: true },
  })
  return destination ? [...input.viewerChannelIds, destination.id] : input.viewerChannelIds
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
      [userId, await resolveDisclosureViewer(prisma, organizationId, userId, {
        allowStoredUoaIdentity: true,
      })] as const),
  )
  return new Map(resolved)
}

/** Rules that decide whether an old grant may lift this particular basis. */
type GrantPolicy = {
  /** A private-lineage message grant must have been made by this one author. */
  messageGrantAuthorId?: string
  messageGrantsAllowed: boolean
  /** Standing grants must never publish private lineage. */
  scopeGrantsAllowed: boolean
}

const scopeKey = (scope: BasisScopeRow) => `${scope.scopeType}:${scope.scopeId}`

const resolveGrantPolicies = async (
  prisma: DisclosureAccessPrisma,
  organizationId: string,
  subjects: readonly DisclosureGrantSubject[],
): Promise<Map<string, GrantPolicy>> => {
  const channelIds = [...new Set(subjects.flatMap((subject) =>
    subject.basis.filter((scope) => scope.scopeType === 'channel').map((scope) => scope.scopeId)))]
  const publicChannelIds = new Set<string>()
  if (channelIds.length > 0) {
    const channels = await prisma.channel.findMany({
      where: { id: { in: channelIds }, organizationId },
      select: { id: true, visibility: true },
    })
    for (const channel of channels) {
      if (channel.visibility === 'public') publicChannelIds.add(channel.id)
    }
  }

  const policies = new Map<string, GrantPolicy>()
  for (const subject of subjects) {
    const sources = subject.disclosureSources ?? []
    const sourceChannelIds = new Set(sources.map((source) => source.sourceChannelId))
    // A source record must account for every non-public channel scope. A
    // partial legacy backfill is not consent for the private source it missed.
    const hasUnattributedNonPublicChannel = subject.basis.some((scope) =>
      scope.scopeType === 'channel'
      && !sourceChannelIds.has(scope.scopeId)
      && !publicChannelIds.has(scope.scopeId))
    if (sources.length > 0) {
      const authorIds = new Set(sources.map((source) => source.sourceAuthorUserId))
      const soleAuthor = authorIds.size === 1 && !authorIds.has(null)
      policies.set(subject.messageId, {
        ...(soleAuthor ? { messageGrantAuthorId: [...authorIds][0] ?? undefined } : {}),
        messageGrantsAllowed: soleAuthor && !hasUnattributedNonPublicChannel,
        scopeGrantsAllowed: false,
      })
      continue
    }
    // A legacy basis with no source author is safe to grant only when every
    // channel it names is demonstrably public. Missing/renamed rows fail closed.
    policies.set(subject.messageId, hasUnattributedNonPublicChannel
      ? { messageGrantsAllowed: false, scopeGrantsAllowed: false }
      : { messageGrantsAllowed: true, scopeGrantsAllowed: true })
  }
  return policies
}

/** The scope keys one basis gains from grant rows already fetched and re-checked. */
const grantedKeysForBasis = (input: {
  basis: readonly BasisScopeRow[]
  granterViewers: Map<string, DisclosureViewer>
  messageGrants: readonly MessageGrantRow[]
  policy: GrantPolicy
  scopeGrants: readonly ScopeGrantRow[]
}): Set<string> => {
  const granted = new Set<string>()
  for (const grant of input.messageGrants) {
    const granter = input.granterViewers.get(grant.grantedByUserId)
    if (
      input.policy.messageGrantsAllowed
      && (
        input.policy.messageGrantAuthorId === undefined
        || grant.grantedByUserId === input.policy.messageGrantAuthorId
      )
      && granter
      && viewerSatisfiesBasis(input.basis, granter)
    ) {
      for (const scope of input.basis) granted.add(scopeKey(scope))
    }
  }
  if (!input.policy.scopeGrantsAllowed) return granted
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
  /** Durable original private-message lineage, when this is a Message basis. */
  disclosureSources?: readonly DisclosureSource[]
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

  const policies = await resolveGrantPolicies(prisma, input.organizationId, restricted)
  const audienceChannelIds = await readableGrantAudienceChannelIds(prisma, input)
  const { messageGrants, scopeGrants } = await fetchGrantRows(prisma, {
    agentIds: [...new Set(restricted.flatMap((message) =>
      message.agentId && policies.get(message.messageId)?.scopeGrantsAllowed
        ? [message.agentId]
        : []))],
    channelId: input.channelId,
    messageIds: restricted.map((message) => message.messageId),
    organizationId: input.organizationId,
    viewerChannelIds: audienceChannelIds,
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
      policy: policies.get(message.messageId)
        ?? { messageGrantsAllowed: false, scopeGrantsAllowed: false },
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
    /** See DisclosureGrantSubject; absent for a run-level ledger. */
    disclosureSources?: readonly DisclosureSource[]
    organizationId: string
    viewerChannelIds: readonly string[]
    viewerUserId: string | null
  },
): Promise<Set<string>> => {
  if (input.basis.length === 0 || !input.viewerUserId) return new Set<string>()

  const subject: DisclosureGrantSubject = {
    agentId: input.agentId,
    basis: input.basis,
    ...(input.disclosureSources ? { disclosureSources: input.disclosureSources } : {}),
    messageId: input.messageId ?? '__run_basis__',
  }
  const policy = (await resolveGrantPolicies(prisma, input.organizationId, [subject])).get(subject.messageId)
    ?? { messageGrantsAllowed: false, scopeGrantsAllowed: false }
  const audienceChannelIds = await readableGrantAudienceChannelIds(prisma, input)
  const { messageGrants, scopeGrants } = await fetchGrantRows(prisma, {
    agentIds: input.agentId && policy.scopeGrantsAllowed ? [input.agentId] : [],
    channelId: input.channelId,
    messageIds: input.messageId ? [input.messageId] : [],
    organizationId: input.organizationId,
    viewerChannelIds: audienceChannelIds,
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
  return grantedKeysForBasis({
    basis: input.basis,
    granterViewers,
    messageGrants,
    policy,
    scopeGrants,
  })
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
    /** See DisclosureGrantSubject; absent for a run-level ledger. */
    disclosureSources?: readonly DisclosureSource[]
    organizationId: string
    /** Only queue delivery may revalidate its stored, scoped product link. */
    allowStoredUoaIdentity?: boolean
    uoaIdentity?: UoaSessionIdentity
    userId: string
  },
): Promise<boolean> => {
  const viewer = await resolveDisclosureViewer(prisma, input.organizationId, input.userId, {
    allowStoredUoaIdentity: input.allowStoredUoaIdentity,
    uoaIdentity: input.uoaIdentity,
  })
  if (viewer.kind !== 'user') return false
  if (viewerSatisfiesBasis(input.basis, viewer)) return true

  const granted = await resolveGrantedDisclosureScopeKeys(prisma, {
    agentId: input.agentId,
    basis: input.basis,
    channelId: input.channelId,
    ...(input.disclosureSources ? { disclosureSources: input.disclosureSources } : {}),
    messageId: input.messageId,
    organizationId: input.organizationId,
    viewerChannelIds: viewer.scopes
      .filter((scope) => scope.scopeType === 'channel')
      .map((scope) => scope.scopeId),
    viewerUserId: viewer.userId,
  })
  return viewerSatisfiesBasis(input.basis, viewer, granted)
}
