import type { Prisma, PrismaClient } from '@prisma/client'
import {
  resolveGrantedDisclosureScopeKeys,
  resolveDisclosureViewer,
} from './disclosure-access.js'
import { viewerSatisfiesBasis, type DisclosureViewer } from './disclosure-predicate.js'

/**
 * Grants lift a restriction. Two kinds, both evaluated at read time:
 *
 *  - a **message grant** — the card's "share this reply" — names one message
 *    and one audience;
 *  - a **scope grant** — "allow always" — names one source scope, one
 *    destination channel, and one agent.
 *
 * Read-time evaluation is what makes revocation immediate and free of
 * propagation: nothing is stamped into the message when a grant is made, so
 * withdrawing it simply stops the next read from passing.
 *
 * A grant is only as good as its granter's current access. Every query below
 * re-checks that the granter still satisfies the source, so someone who leaves
 * a project cannot leave a standing disclosure behind them.
 */

/**
 * Scope keys (`type:id`) a viewer holds by grant rather than by membership, for
 * one message in one channel. Fed to `viewerSatisfiesBasis`.
 */
export const resolveGrantedScopeKeys = resolveGrantedDisclosureScopeKeys

/**
 * May this user grant this message's disclosure?
 *
 * Only a human who **currently** satisfies the message's full basis — checked
 * against live membership, not against who authored it. Agents never reach this
 * path: the route requires a user session.
 */
export const canGrantDisclosure = async (
  prisma: DisclosureGrantPrisma,
  input: { organizationId: string; userId: string; basis: readonly { scopeType: string; scopeId: string }[] },
): Promise<boolean> => {
  if (input.basis.length === 0) {
    return false
  }
  const viewer: DisclosureViewer = await resolveDisclosureViewer(
    prisma,
    input.organizationId,
    input.userId,
  )
  return viewerSatisfiesBasis(input.basis, viewer)
}

/**
 * Duration presets the card offers, capped by the most restrictive tier in the
 * basis.
 *
 * `user`-audience material gets no standing option at all: a standing grant is
 * consent to future, unseen content, which over private material is a wiretap
 * rather than a disclosure — and its misuse is invisible to the grantor, since
 * nobody else is in the source scope to notice. Duration changes the blast
 * radius, not the kind of consent, so the argument holds at every length.
 */
export const ALLOWED_GRANT_DURATIONS = ['10m', 'today', '30d', 'forever'] as const
export type GrantDuration = (typeof ALLOWED_GRANT_DURATIONS)[number]

export const allowedDurationsForBasis = (
  basis: readonly { scopeType: string }[],
): GrantDuration[] =>
  basis.some((scope) => scope.scopeType === 'user')
    ? []
    : [...ALLOWED_GRANT_DURATIONS]

export const expiryForDuration = (
  duration: GrantDuration,
  now: Date,
): Date | null => {
  switch (duration) {
    case '10m':
      return new Date(now.getTime() + 10 * 60_000)
    case 'today': {
      const endOfDay = new Date(now)
      endOfDay.setHours(23, 59, 59, 999)
      return endOfDay
    }
    case '30d':
      return new Date(now.getTime() + 30 * 24 * 60 * 60_000)
    case 'forever':
      return null
  }
}

/**
 * A grant refusal the route already knows how to render: the code and status
 * travel with the workflow function instead of being re-derived at the route.
 */
export class DisclosureGrantError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'DisclosureGrantError'
    this.code = code
    this.status = status
  }
}

type DisclosureGrantPrisma = PrismaClient | Prisma.TransactionClient

type GrantableMessage = {
  content: string
  id: string
  agentId: string | null
  thread: { channelId: string }
  basisScopes: { scopeType: string; scopeId: string }[]
  disclosureSources: { sourceAuthorUserId: string | null; sourceChannelId: string }[]
}

/**
 * Loads the message a grant would be about, and checks the two things every
 * grant needs regardless of kind: the granter is in the room the message was
 * posted in, the message is actually restricted, and the granter currently
 * satisfies its full basis themselves.
 */
const loadGrantableMessage = async (
  prisma: DisclosureGrantPrisma,
  input: { organizationId: string; userId: string; messageId: string },
): Promise<GrantableMessage> => {
  // Organisation scope alone is not enough to be *in the room*. Satisfying a
  // message's basis (a team scope, say) does not imply membership of the
  // channel it was posted in, so without this a member could share a reply
  // out of a channel they cannot see — and, with `audienceKind: 'channel'`,
  // publish it into one. Same visibility rule the thread read uses.
  const message = await prisma.message.findFirst({
    where: {
      id: input.messageId,
      thread: {
        channel: {
          organizationId: input.organizationId,
          OR: [
            { visibility: 'public' },
            { members: { some: { userId: input.userId } } },
          ],
        },
      },
    },
    select: {
      content: true,
      id: true,
      agentId: true,
      thread: { select: { channelId: true } },
      basisScopes: { select: { scopeType: true, scopeId: true } },
      disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
    },
  })
  if (!message) {
    throw new DisclosureGrantError('MESSAGE_NOT_FOUND', 'Message not found', 404)
  }
  if (message.basisScopes.length === 0) {
    throw new DisclosureGrantError(
      'DISCLOSURE_NOT_RESTRICTED',
      'This message is not restricted, so there is nothing to share.',
      409,
    )
  }

  const entitled = await canGrantDisclosure(prisma, {
    basis: message.basisScopes,
    organizationId: input.organizationId,
    userId: input.userId,
  })
  if (!entitled) {
    throw new DisclosureGrantError(
      'DISCLOSURE_GRANT_NOT_ENTITLED',
      'You can only share content you can reach yourself.',
      403,
    )
  }
  return message
}

/**
 * Reaching a private conversation is not authority to export it. The person
 * whose words made it into the reply must grant that exact disclosure. A reply
 * with several authors therefore needs a separate consent path; one author
 * cannot turn a card intended for another author's material into a blanket
 * release. Old restricted rows have no lineage, so their manual share fails
 * closed instead of treating a missing author as a permit.
 */
const assertOriginalPrivateConversationAuthor = (
  message: GrantableMessage,
  userId: string,
): void => {
  if (message.disclosureSources.some((source) => !source.sourceAuthorUserId)) {
    throw new DisclosureGrantError(
      'DISCLOSURE_ORIGINAL_AUTHOR_UNKNOWN',
      'This private conversation cannot be shared because its original author is not recorded.',
      409,
    )
  }
  const authorIds = new Set(message.disclosureSources.map((source) => source.sourceAuthorUserId))
  const channelScopes = message.basisScopes
    .filter((scope) => scope.scopeType === 'channel')
    .map((scope) => scope.scopeId)
  const sourceChannels = new Set(message.disclosureSources.map((source) => source.sourceChannelId))
  if (channelScopes.some((channelId) => !sourceChannels.has(channelId))) {
    throw new DisclosureGrantError(
      'DISCLOSURE_ORIGINAL_AUTHOR_UNKNOWN',
      'This private conversation cannot be shared because its original author is not recorded.',
      409,
    )
  }
  if (authorIds.size > 0 && (authorIds.size !== 1 || !authorIds.has(userId))) {
    throw new DisclosureGrantError(
      'DISCLOSURE_ORIGINAL_AUTHOR_REQUIRED',
      'Only the original author of this private conversation can share it.',
      403,
    )
  }
}

export type GrantMessageDisclosureInput = {
  /** Exact body the human reviewed before granting this one-message disclosure. */
  expectedContent: string
  organizationId: string
  userId: string
  messageId: string
  audienceKind?: 'user' | 'channel'
  audienceId?: string
  duration?: GrantDuration
}

/**
 * Shares one reply, one time, with one audience — the acknowledgement card's
 * "share this" action.
 *
 * Unlike a standing rule, a one-off share is not capped by
 * `allowedDurationsForBasis`: it discloses one message that already exists,
 * not future unseen content, so the "no standing option for private material"
 * argument does not apply here.
 */
export const grantMessageDisclosure = async (
  prisma: PrismaClient,
  input: GrantMessageDisclosureInput,
): Promise<{ id: string }> => {
  return prisma.$transaction(async (tx) => {
    // The content-change trigger takes this exact lock before it revokes
    // grants. Take it before reading, validating or upserting, so a grant can
    // never land for a body the granter did not review.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtextextended(${`disclosure-message:${input.messageId}`}::text, 0)
    )`

    const message = await loadGrantableMessage(tx, input)
    if (message.content !== input.expectedContent) {
      throw new DisclosureGrantError(
        'DISCLOSURE_CONTENT_CHANGED',
        'This reply changed before it could be shared. Review the current reply and try again.',
        409,
      )
    }
    assertOriginalPrivateConversationAuthor(message, input.userId)

    // Default to the shortest option: a share should expire unless the granter
    // deliberately chose otherwise.
    const duration = input.duration ?? '10m'
    const audienceKind = input.audienceKind ?? 'channel'
    const expiresAt = expiryForDuration(duration, new Date())
    const audienceId = input.audienceId ?? message.thread.channelId

    // The audience was accepted as any uuid. A share is only as bounded as the
    // audience it names, so an unchecked one lets a granter widen a
    // restriction to a room they are not in, or to a stranger. Both are
    // resolved against the granter's own reach, never merely the organisation.
    const audienceExists = audienceKind === 'user'
      ? await tx.organizationMember.findFirst({
        where: {
          deactivatedAt: null,
          organizationId: input.organizationId,
          userId: audienceId,
        },
        select: { id: true },
      })
      : await tx.channel.findFirst({
        where: {
          id: audienceId,
          organizationId: input.organizationId,
          OR: [
            { visibility: 'public' },
            { members: { some: { userId: input.userId } } },
          ],
        },
        select: { id: true },
      })
    if (!audienceExists) {
      throw new DisclosureGrantError(
        'DISCLOSURE_AUDIENCE_NOT_FOUND',
        audienceKind === 'user'
          ? 'That person is not an active member of this organisation.'
          : 'That channel does not exist, or you are not in it.',
        422,
      )
    }

    const grant = await tx.disclosureGrant.upsert({
      where: {
        messageId_audienceKind_audienceId: {
          messageId: message.id,
          audienceKind,
          audienceId,
        },
      },
      create: {
        audienceId,
        audienceKind,
        // A one-off share expires like a standing rule does.
        ...(expiresAt ? { expiresAt } : {}),
        grantedByUserId: input.userId,
        messageId: message.id,
        organizationId: input.organizationId,
      },
      update: {
        ...(expiresAt ? { expiresAt } : { expiresAt: null }),
        // Re-approval replaces a legacy reader-approved grant with the current
        // original author's authority, which the read predicate verifies.
        grantedByUserId: input.userId,
        revokedAt: null,
      },
      select: { id: true },
    })
    return { id: grant.id }
  })
}

export type GrantScopeDisclosureInput = {
  organizationId: string
  userId: string
  messageId: string
  duration?: GrantDuration
}

/**
 * Stands up a standing rule — "always let this agent's replies out of this
 * scope into this channel" — for every basis scope the message carries.
 *
 * One row per (source scope, destination channel, agent). Non-widening is
 * structural: no wildcard, no inheritance, no fallback in the lookup.
 */
export const grantScopeDisclosure = async (
  prisma: PrismaClient,
  input: GrantScopeDisclosureInput,
): Promise<{ ids: string[] }> => {
  const message = await loadGrantableMessage(prisma, input)
  assertOriginalPrivateConversationAuthor(message, input.userId)

  if (message.disclosureSources.length > 0) {
    throw new DisclosureGrantError(
      'DISCLOSURE_SCOPE_GRANT_PRIVATE_CONVERSATION',
      'A private conversation can only be shared one reply at a time.',
      422,
    )
  }

  // The duration menu is capped by the most restrictive tier in the basis:
  // private material gets no standing option at all.
  const allowed = allowedDurationsForBasis(message.basisScopes)
  const duration = input.duration ?? '10m'
  if (!allowed.includes(duration)) {
    throw new DisclosureGrantError(
      'DISCLOSURE_DURATION_NOT_ALLOWED',
      'A standing rule is not available for this material.',
      422,
    )
  }
  if (!message.agentId) {
    throw new DisclosureGrantError(
      'DISCLOSURE_SCOPE_GRANT_NEEDS_AGENT',
      'A standing rule applies to one agent, and this message has no agent author.',
      409,
    )
  }

  const expiresAt = expiryForDuration(duration, new Date())
  const agentId = message.agentId
  const created = await prisma.$transaction(
    message.basisScopes.map((scope) =>
      prisma.scopeDisclosureGrant.upsert({
        where: {
          sourceScopeType_sourceScopeId_destinationChannelId_agentId: {
            sourceScopeType: scope.scopeType,
            sourceScopeId: scope.scopeId,
            destinationChannelId: message.thread.channelId,
            agentId,
          },
        },
        create: {
          agentId,
          destinationChannelId: message.thread.channelId,
          ...(expiresAt ? { expiresAt } : {}),
          grantedByUserId: input.userId,
          organizationId: input.organizationId,
          sourceScopeId: scope.scopeId,
          sourceScopeType: scope.scopeType,
        },
        update: {
          ...(expiresAt ? { expiresAt } : { expiresAt: null }),
          revokedAt: null,
        },
        select: { id: true },
      })),
  )
  return { ids: created.map((row: { id: string }) => row.id) }
}
