/**
 * The one place an automatic domain rule turns into team membership.
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §9.
 *
 * It lives in this package, not in `api/src/services`, because both callers
 * need it: the sign-in provisioning job and the reconciliation job, both in the
 * worker, which cannot import api services. Keeping it single also keeps its
 * two invariants in one readable place:
 *
 *  1. **Every grant carries a principal.** A rule records the administrator who
 *     authorized it; each call mints a fresh 60-second org-scoped subject
 *     assertion for that subject, so UOA re-resolves their live organisation
 *     membership and role on every single call. That is the authorization —
 *     Nessie never writes a membership row and never falls back to backend
 *     mode, which applies no role check at all. It is also what makes
 *     "re-check authorization before every batch" a mechanism rather than a
 *     claim: the assertion is minted per batch and verified upstream.
 *
 *  2. **Never send a role.** `addTeamMember` forwards `team_role` whenever it
 *     is given, and UOA's member add is becoming an upsert, so passing
 *     `'member'` would silently demote an existing team owner. Membership is
 *     read first and the add is skipped entirely when the person is already
 *     there, exactly as the manual team-access route does.
 */

import type { PrismaClient } from '@prisma/client'
import { createUoaSubjectAssertion } from '@nessie/runtime'

import { addTeamMember } from './uoa-org-roster-pages.js'
import { listOrganisationMemberTeamAccess } from './uoa-org-members.js'
import {
  delegatedSettings,
  UoaRosterRejectedError,
  type UoaRosterDeps,
} from './uoa-org-roster.js'

/** How long one in-flight upstream call may hold a ledger row. */
const GRANT_LEASE_MS = 2 * 60 * 1000

/**
 * The two UOA calls a grant makes, injectable so tests can drive every branch
 * without a network. Same seam convention as `rosterDeps` and the DNS resolver;
 * production passes nothing.
 */
export type AutomaticGrantUpstream = {
  listTeamAccess: typeof listOrganisationMemberTeamAccess
  addTeamMember: typeof addTeamMember
  /**
   * Awaited before EVERY upstream request. One grant makes two — the
   * per-subject pre-read and the add — so pacing once per grant would let
   * through twice the intended rate.
   */
  pace?: () => Promise<void>
}

export const defaultAutomaticGrantUpstream: AutomaticGrantUpstream = {
  addTeamMember,
  listTeamAccess: listOrganisationMemberTeamAccess,
}

export type AutomaticGrantOutcome =
  | 'granted'
  | 'skipped_existing'
  | 'skipped_no_such_team'
  | 'in_flight'
  | 'failed'
  | 'unauthorized'

export type AutomaticGrantSource = 'signin' | 'reconcile'

export type AutomaticGrantPrisma = Pick<
  PrismaClient,
  'automaticMembershipGrant' | 'automaticMembershipRule'
>

export type AutomaticGrantRule = {
  id: string
  teamId: string
  /** For the health alert's message; never used for authorization. */
  teamName: string
  externalOrgId: string
  externalTeamId: string
  authorizedByUoaSub: string
  authorizedTokenVersion: number
  authorizedTeamId: string
}

export type AutomaticGrantResult = {
  outcome: AutomaticGrantOutcome
  reason?: string
  /**
   * Set only on the call that actually moved the rule into
   * `needs_reauthorization`, so the caller alerts exactly once per transition
   * rather than once per person in a long reconciliation.
   */
  healthTransition?: { healthRevision: number }
}

/**
 * Mint the acting principal for one upstream call. Deliberately per call and
 * never cached: a stale assertion would be exactly the missing liveness check
 * this design exists to provide. The audience matches
 * `withUoaOrgRosterSubjectAssertion`, which is what UOA validates.
 */
const assertionDepsFor = (
  rule: AutomaticGrantRule,
  deps: UoaRosterDeps,
): UoaRosterDeps => {
  const settings = delegatedSettings()
  return {
    ...deps,
    subjectAssertion: createUoaSubjectAssertion(
      settings,
      {
        organizationId: rule.externalOrgId,
        subject: rule.authorizedByUoaSub,
        teamId: rule.authorizedTeamId,
        tokenVersion: rule.authorizedTokenVersion,
      },
      `${settings.authBaseUrl}/org`,
    ),
  }
}

/** UOA refusing the authorizer is an authorization loss, not a transport fault. */
const isAuthorizationLoss = (error: unknown): boolean =>
  error instanceof UoaRosterRejectedError
  && (error.statusCode === 401 || error.statusCode === 403)

/**
 * Claim the ledger row for this (rule, person) and COMMIT before the upstream
 * call. Revision 1 of the plan held a transaction open across a 10-second
 * roster request, which parks a connection and — worse — makes a second worker
 * *block* on the unique index rather than skip, because an uncommitted insert
 * raises no conflict. A committed row with a lease is what lets a peer skip.
 */
const claimGrant = async (
  prisma: AutomaticGrantPrisma,
  ruleId: string,
  uoaSub: string,
  source: AutomaticGrantSource,
): Promise<'claimed' | 'in_flight' | AutomaticGrantOutcome> => {
  const now = new Date()
  const existing = await prisma.automaticMembershipGrant.findUnique({
    where: { ruleId_uoaSub: { ruleId, uoaSub } },
    select: { outcome: true, leaseExpiresAt: true },
  })

  if (existing) {
    if (existing.outcome === 'granted') return 'granted'
    if (existing.outcome === 'skipped_existing') return 'skipped_existing'
    if (existing.outcome === 'skipped_no_such_team') return 'skipped_no_such_team'
    if (
      existing.outcome === 'attempted'
      && existing.leaseExpiresAt
      && existing.leaseExpiresAt > now
    ) {
      return 'in_flight'
    }
  }

  // A conditional update on the lease, so two workers racing an expired lease
  // resolve to exactly one claimer.
  const lease = new Date(now.getTime() + GRANT_LEASE_MS)
  if (existing) {
    const claimed = await prisma.automaticMembershipGrant.updateMany({
      where: {
        ruleId,
        uoaSub,
        outcome: { in: ['attempted', 'failed'] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: { attempts: { increment: 1 }, leaseExpiresAt: lease, outcome: 'attempted', source },
    })
    return claimed.count === 1 ? 'claimed' : 'in_flight'
  }

  try {
    await prisma.automaticMembershipGrant.create({
      data: { attempts: 1, leaseExpiresAt: lease, outcome: 'attempted', ruleId, source, uoaSub },
    })
    return 'claimed'
  } catch (error) {
    // Only a unique violation means a peer won the race. Anything else — a
    // dropped connection, a constraint fault — must not be reported as
    // somebody else's lease, or the job would "succeed" having done nothing.
    if ((error as { code?: string }).code === 'P2002') return 'in_flight'
    throw error
  }
}

const settleGrant = async (
  prisma: AutomaticGrantPrisma,
  ruleId: string,
  uoaSub: string,
  outcome: AutomaticGrantOutcome,
  reason?: string,
): Promise<void> => {
  await prisma.automaticMembershipGrant.update({
    where: { ruleId_uoaSub: { ruleId, uoaSub } },
    data: {
      failureReason: reason ?? null,
      leaseExpiresAt: null,
      outcome: outcome === 'in_flight' || outcome === 'unauthorized' ? 'failed' : outcome,
    },
  })
}

/**
 * Move a rule to the state that names its remedy, per
 * docs/standards/capability-health-alerts.md. The revision bump is what makes
 * the alert exactly-once per transition; a rule already in the state is left
 * alone so a long reconciliation cannot re-alert on every batch.
 */
export const markRuleNeedsReauthorization = async (
  prisma: AutomaticGrantPrisma,
  ruleId: string,
  reason: string,
): Promise<{ healthRevision: number } | null> => {
  const moved = await prisma.automaticMembershipRule.updateMany({
    where: { id: ruleId, healthState: 'ok' },
    data: {
      healthReason: reason.slice(0, 500),
      healthRevision: { increment: 1 },
      healthState: 'needs_reauthorization',
    },
  })
  if (moved.count !== 1) return null
  // Read back the revision the transition produced: it is what makes the
  // caller's alert exactly-once, through `user_alerts (user_id, event_key)`.
  const rule = await prisma.automaticMembershipRule.findUnique({
    select: { healthRevision: true },
    where: { id: ruleId },
  })
  return rule ? { healthRevision: rule.healthRevision } : null
}

/**
 * Grant one person membership of one rule's team, idempotently.
 *
 * The caller is responsible for having already checked that the rule is
 * enabled, its domain active, the instance flag on and the organisation's
 * emergency stop not engaged — those are cheap reads it does once per batch.
 * This function owns the ledger, the principal and the upstream call.
 */
export const grantAutomaticMembership = async (
  prisma: AutomaticGrantPrisma,
  rule: AutomaticGrantRule,
  uoaSub: string,
  source: AutomaticGrantSource,
  deps: UoaRosterDeps = {},
  upstream: AutomaticGrantUpstream = defaultAutomaticGrantUpstream,
): Promise<AutomaticGrantResult> => {
  const claim = await claimGrant(prisma, rule.id, uoaSub, source)
  if (claim !== 'claimed') {
    return { outcome: claim as AutomaticGrantOutcome }
  }

  try {
    const assertionDeps = assertionDepsFor(rule, deps)
    await upstream.pace?.()
    const access = await upstream.listTeamAccess(
      rule.externalOrgId,
      uoaSub,
      assertionDeps,
    )
    const target = access.items.find((team) => team.id === rule.externalTeamId)

    if (!target) {
      // Deliberately NOT terminal. `listOrganisationMemberTeamAccess`
      // answers within the authorizer's own authority and drops rows missing a
      // field, so a temporary scope reduction or a partial response would
      // otherwise burn this (rule, person) pair permanently. The lease is
      // released instead, so the next pass re-asks.
      await prisma.automaticMembershipGrant.update({
        where: { ruleId_uoaSub: { ruleId: rule.id, uoaSub } },
        data: {
          failureReason: 'UnlikeOtherAI did not offer this team for this person.',
          leaseExpiresAt: null,
          outcome: 'attempted',
        },
      })
      return { outcome: 'skipped_no_such_team' }
    }
    if (target.hasAccess) {
      // Already on the team. Their existing role — which may be owner or admin
      // — is left exactly as it is; this is the branch that preserves it.
      await settleGrant(prisma, rule.id, uoaSub, 'skipped_existing')
      return { outcome: 'skipped_existing' }
    }

    // No `teamRole`: see the header. An ordinary member is what UOA's own
    // default produces, and naming a role here is what would demote someone.
    await upstream.pace?.()
    await upstream.addTeamMember(
      { externalOrgId: rule.externalOrgId, externalTeamId: rule.externalTeamId },
      { uoaSub },
      assertionDeps,
    )
    await settleGrant(prisma, rule.id, uoaSub, 'granted')
    return { outcome: 'granted' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    if (isAuthorizationLoss(error)) {
      await settleGrant(prisma, rule.id, uoaSub, 'unauthorized', reason)
      const transition = await markRuleNeedsReauthorization(prisma, rule.id, reason)
      return {
        outcome: 'unauthorized',
        reason,
        ...(transition ? { healthTransition: transition } : {}),
      }
    }
    // Transport or 5xx: release the lease so the next pass retries rather than
    // burning the person's only chance at this rule.
    await prisma.automaticMembershipGrant.update({
      where: { ruleId_uoaSub: { ruleId: rule.id, uoaSub } },
      data: { failureReason: reason.slice(0, 500), leaseExpiresAt: null, outcome: 'attempted' },
    })
    return { outcome: 'failed', reason }
  }
}
