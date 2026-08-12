import type { PrismaClient } from '@prisma/client'
import { viewerSatisfiesBasis, type DisclosureViewer } from '@nessie/runtime'
import { resolveMessageViewer } from './disclosure-viewer.js'

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

const liveGrantFilter = (now: Date) => ({
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
})

/**
 * Scope keys (`type:id`) a viewer holds by grant rather than by membership, for
 * one message in one channel. Fed to `viewerSatisfiesBasis`.
 */
export const resolveGrantedScopeKeys = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    messageId: string
    channelId: string
    agentId: string | null
    viewerUserId: string | null
    viewerChannelIds: readonly string[]
    basis: readonly { scopeType: string; scopeId: string }[]
  },
): Promise<Set<string>> => {
  const granted = new Set<string>()
  if (input.basis.length === 0 || !input.viewerUserId) {
    return granted
  }
  const now = new Date()

  const [messageGrants, scopeGrants] = await Promise.all([
    prisma.disclosureGrant.findMany({
      where: {
        messageId: input.messageId,
        organizationId: input.organizationId,
        ...liveGrantFilter(now),
        OR: [
          { audienceKind: 'user', audienceId: input.viewerUserId },
          // A channel grant follows live membership, so someone who joins the
          // channel later is covered without the grant being reissued.
          { audienceKind: 'channel', audienceId: { in: [...input.viewerChannelIds] } },
        ],
      },
      select: { id: true, grantedByUserId: true },
    }),
    input.agentId
      ? prisma.scopeDisclosureGrant.findMany({
        where: {
          organizationId: input.organizationId,
          destinationChannelId: input.channelId,
          agentId: input.agentId,
          ...liveGrantFilter(now),
        },
        select: { sourceScopeType: true, sourceScopeId: true, grantedByUserId: true },
      })
      : Promise.resolve([]),
  ])

  // A message grant lifts the whole basis for this viewer, but only while its
  // granter still satisfies that basis themselves.
  for (const grant of messageGrants) {
    const granterViewer = await resolveMessageViewer(
      prisma,
      input.organizationId,
      grant.grantedByUserId,
    )
    if (viewerSatisfiesBasis(input.basis, granterViewer)) {
      for (const scope of input.basis) {
        granted.add(`${scope.scopeType}:${scope.scopeId}`)
      }
    }
  }

  // A scope grant lifts exactly its own scope — never a neighbouring one.
  for (const grant of scopeGrants) {
    const granterViewer = await resolveMessageViewer(
      prisma,
      input.organizationId,
      grant.grantedByUserId,
    )
    if (
      viewerSatisfiesBasis(
        [{ scopeId: grant.sourceScopeId, scopeType: grant.sourceScopeType }],
        granterViewer,
      )
    ) {
      granted.add(`${grant.sourceScopeType}:${grant.sourceScopeId}`)
    }
  }

  return granted
}

/**
 * May this user grant this message's disclosure?
 *
 * Only a human who **currently** satisfies the message's full basis — checked
 * against live membership, not against who authored it. Agents never reach this
 * path: the route requires a user session.
 */
export const canGrantDisclosure = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; basis: readonly { scopeType: string; scopeId: string }[] },
): Promise<boolean> => {
  if (input.basis.length === 0) {
    return false
  }
  const viewer: DisclosureViewer = await resolveMessageViewer(
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
