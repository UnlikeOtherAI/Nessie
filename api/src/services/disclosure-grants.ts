import type { PrismaClient } from '@prisma/client'
import {
  resolveGrantedDisclosureScopeKeys,
  resolveDisclosureViewer,
  viewerSatisfiesBasis,
  type DisclosureViewer,
} from '@nessie/runtime'

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
  prisma: PrismaClient,
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
