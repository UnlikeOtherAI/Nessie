import type { PrismaClient } from '@prisma/client'
import type { NormalisedItem } from '@nessie/board-sources'
import type { BoardSourceProvider } from '@nessie/schemas'

/**
 * Who a provider's user is here.
 *
 * `BoardSourceIdentityLink` is the only place a provider identity meets a
 * Nessie one, and this module is the only place that writes one without a
 * person choosing it. Two rules shape everything below:
 *
 * - **Nothing here creates a person.** A match is a *lookup* of an active
 *   organisation member by the address UOA already mirrors onto `User.email`;
 *   an upstream user with no Nessie account stays a provider fact, named on
 *   the card as somebody we do not know.
 * - **A person's decision outranks a match.** An external user that already has
 *   a link — including one deliberately left unlinked — is never re-matched, so
 *   an override survives every sync.
 */

export type IdentityTenant = {
  organizationId: string
  /** Jira cloudId, Linear organisation id, or the provider name. */
  externalTenantKey: string
  provider: BoardSourceProvider
}

export type ExternalIdentityCandidate = {
  externalUserId: string
  displayName: string | null
  email: string | null
}

export type ResolvedIdentity = { userId: string | null; agentId: string | null }

export type IdentityLinkProjection = ExternalIdentityCandidate & ResolvedIdentity

/**
 * The tenant one identity mapping covers. Jira's is the site (a 3LO token spans
 * sites, so the container carries it); Linear's is the workspace; the others
 * have no tenant of their own, so the provider name is the key.
 *
 * One definition, because a second reading of "which mapping is this" would
 * silently split one workspace's people into two mapping tables.
 */
export const externalTenantKeyFor = (source: {
  provider: BoardSourceProvider
  container: unknown
  connection?: { externalTenantId?: string }
}): string => {
  const container = (source.container ?? {}) as Record<string, unknown>
  if (source.provider === 'jira') return String(container.cloudId ?? '')
  if (source.provider === 'linear') return source.connection?.externalTenantId ?? ''
  return source.provider
}

/**
 * Every identity link for one provider tenant, as the apply context wants it.
 * Scoped to the tenant rather than the source, so one mapping serves every
 * project that reads the same Linear organisation or Jira site.
 */
export const loadIdentityLinks = async (
  prisma: PrismaClient,
  tenant: IdentityTenant,
): Promise<Map<string, ResolvedIdentity>> => {
  const links = await prisma.boardSourceIdentityLink.findMany({
    where: {
      organizationId: tenant.organizationId,
      provider: tenant.provider,
      externalTenantKey: tenant.externalTenantKey,
    },
    select: { externalUserId: true, userId: true, agentId: true },
  })
  return new Map(
    links.map((link) => [link.externalUserId, { userId: link.userId, agentId: link.agentId }]),
  )
}

/**
 * Link the provider users we can recognise, by exact, case-folded email against
 * an **active** member of the organisation. Never fuzzy, never a display-name
 * comparison: a wrong match assigns somebody else's work to a real person.
 *
 * Returns the links it wrote, already re-projected onto the tasks that were
 * mirrored before the match existed — a mapping that only applied to future
 * items would leave the board showing the same unknown name it did yesterday.
 */
export const autoMatchIdentitiesByEmail = async (
  prisma: PrismaClient,
  tenant: IdentityTenant,
  candidates: readonly ExternalIdentityCandidate[],
): Promise<IdentityLinkProjection[]> => {
  // One address naming two provider users is not a match anybody can trust, so
  // it matches neither rather than picking the one that happened to sort first.
  const byEmail = new Map<string, ExternalIdentityCandidate | null>()
  for (const candidate of candidates) {
    const email = candidate.email?.trim().toLowerCase()
    if (!email) continue
    byEmail.set(email, byEmail.has(email) ? null : candidate)
  }
  const undecided = [...byEmail.values()].filter(
    (candidate): candidate is ExternalIdentityCandidate => candidate !== null,
  )
  if (undecided.length === 0) return []

  const decided = await prisma.boardSourceIdentityLink.findMany({
    where: {
      organizationId: tenant.organizationId,
      provider: tenant.provider,
      externalTenantKey: tenant.externalTenantKey,
      externalUserId: { in: undecided.map((candidate) => candidate.externalUserId) },
    },
    select: { externalUserId: true },
  })
  const alreadyDecided = new Set(decided.map((link) => link.externalUserId))
  const open = undecided.filter((candidate) => !alreadyDecided.has(candidate.externalUserId))
  if (open.length === 0) return []

  // A deactivated membership is not somebody work may be assigned to, so it is
  // not somebody an upstream assignee may resolve to either.
  const members = await prisma.organizationMember.findMany({
    where: {
      organizationId: tenant.organizationId,
      deactivatedAt: null,
      user: {
        email: { in: open.map((candidate) => candidate.email?.trim().toLowerCase() ?? '') },
      },
    },
    select: { userId: true, user: { select: { email: true } } },
  })
  const userByEmail = new Map(members.map((member) => [member.user.email.toLowerCase(), member.userId]))

  const matched: IdentityLinkProjection[] = []
  for (const candidate of open) {
    const userId = userByEmail.get(candidate.email?.trim().toLowerCase() ?? '')
    if (!userId) continue
    matched.push({ ...candidate, userId, agentId: null })
  }
  if (matched.length === 0) return []

  await prisma.boardSourceIdentityLink.createMany({
    data: matched.map((link) => ({
      organizationId: tenant.organizationId,
      provider: tenant.provider,
      externalTenantKey: tenant.externalTenantKey,
      externalUserId: link.externalUserId,
      externalDisplayName: link.displayName,
      userId: link.userId,
      matchedBy: 'email',
    })),
    // A concurrent sync may have matched the same person a moment ago; the
    // unique key decides and both runs project the same result.
    skipDuplicates: true,
  })
  await reprojectIdentityLinks(prisma, tenant, matched)
  return matched
}

/**
 * Auto-match the assignees a page of items actually names, and fold the result
 * into the map the apply context reads.
 *
 * The item's own assignee is the candidate list that matters: it needs no extra
 * provider call, and it covers the person who joined the upstream team after
 * the source was attached. Candidates that resolve to nobody are remembered as
 * unresolved for the rest of the run, so one page of a hundred issues by the
 * same stranger costs one lookup rather than a hundred.
 */
export const autoMatchItemAssignees = async (
  prisma: PrismaClient,
  tenant: IdentityTenant,
  items: readonly NormalisedItem[],
  known: Map<string, ResolvedIdentity>,
): Promise<void> => {
  const candidates = new Map<string, ExternalIdentityCandidate>()
  for (const item of items) {
    const assignee = item.assignee
    if (!assignee?.email || known.has(assignee.externalUserId)) continue
    candidates.set(assignee.externalUserId, {
      externalUserId: assignee.externalUserId,
      displayName: assignee.displayName,
      email: assignee.email,
    })
  }
  if (candidates.size === 0) return

  const matched = await autoMatchIdentitiesByEmail(prisma, tenant, [...candidates.values()])
  for (const externalUserId of candidates.keys()) {
    known.set(externalUserId, { userId: null, agentId: null })
  }
  for (const link of matched) {
    known.set(link.externalUserId, { userId: link.userId, agentId: link.agentId })
  }
}

/**
 * Apply a link to the items already mirrored under it.
 *
 * Without this a mapping only ever reaches items that change afterwards: every
 * card assigned to that person upstream would keep showing an unknown name
 * until somebody upstream happened to touch it. Bounded by the links that
 * actually changed, which in a person's edit is normally one.
 */
export const reprojectIdentityLinks = async (
  prisma: PrismaClient,
  tenant: IdentityTenant,
  links: readonly IdentityLinkProjection[],
): Promise<number> => {
  if (links.length === 0) return 0
  const sourceIds = await tenantSourceIds(prisma, tenant)
  if (sourceIds.length === 0) return 0

  let touched = 0
  for (const link of links) {
    const rows = await prisma.taskExternalLink.findMany({
      where: { sourceId: { in: sourceIds }, remoteAssigneeExternalId: link.externalUserId },
      select: { id: true, taskId: true },
    })
    if (rows.length === 0) continue
    const taskIds = rows.map((row) => row.taskId)
    const resolved = Boolean(link.userId || link.agentId)

    await prisma.task.updateMany({
      where: { id: { in: taskIds } },
      data: { assigneeUserId: link.userId, assigneeAgentId: link.agentId },
    })
    // `todo` is the one category whose status depends on whether anybody is on
    // the item, and `inbox`/`assigned` are the only two statuses it produces —
    // the same rule `statusForItem` applies on the way in.
    await prisma.task.updateMany({
      where: { id: { in: taskIds }, status: resolved ? 'inbox' : 'assigned' },
      data: { status: resolved ? 'assigned' : 'inbox' },
    })

    // The upstream name is what the card falls back to, so it is cleared when
    // we know who this is and left alone when the link cannot name anybody.
    if (resolved) {
      await prisma.taskExternalLink.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { remoteAssigneeDisplay: null },
      })
    } else if (link.displayName) {
      await prisma.taskExternalLink.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { remoteAssigneeDisplay: link.displayName },
      })
    }
    touched += rows.length
  }
  return touched
}

/** Every source in the organisation that reads this provider tenant. */
const tenantSourceIds = async (
  prisma: PrismaClient,
  tenant: IdentityTenant,
): Promise<string[]> => {
  const sources = await prisma.boardSource.findMany({
    where: { organizationId: tenant.organizationId, provider: tenant.provider },
    select: {
      id: true,
      provider: true,
      container: true,
      connection: { select: { externalTenantId: true } },
    },
  })
  return sources
    .filter((source) => externalTenantKeyFor(source) === tenant.externalTenantKey)
    .map((source) => source.id)
}
