/**
 * The domain-claim state machine for automatic team access.
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §7.
 *
 * Claiming, proving, rotating, suspending, resuming and releasing a domain.
 * The DNS half lives in `@nessie/team-admin` so the worker's revalidation sweep
 * reaches the same verdict from the same code; this file owns persistence and
 * the transitions.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import {
  checkDomainChallenge,
  defaultDomainVerificationDns,
  evaluateVerification,
  generateDomainChallenge,
  CHALLENGE_TTL_MS,
  type DomainVerificationDns,
} from '@nessie/team-admin'
import { classifyEmailDomain, normaliseDomain, type DomainRejection } from '@nessie/schemas'
import { isPublicSuffix } from '@nessie/runtime'

export type DomainServicePrisma = Pick<PrismaClient, 'automaticMembershipDomain'>

export class AutomaticMembershipDomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly rejection?: DomainRejection,
  ) {
    super(message)
    this.name = 'AutomaticMembershipDomainError'
  }
}

/** Postgres unique-violation, which here always means the exclusivity index. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as { code?: string }).code === 'P2002'

const claimedElsewhere = (): AutomaticMembershipDomainError =>
  new AutomaticMembershipDomainError(
    'Another organisation has already verified this domain. Use manual invitations until that claim is released.',
    'AUTOMATIC_MEMBERSHIP_DOMAIN_CLAIMED',
    409,
  )

const freshChallenge = (now: Date) => ({
  challenge: generateDomainChallenge(),
  challengeExpiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  challengeIssuedAt: now,
  firstSeenAt: null,
})

/**
 * Claim a domain for an organisation. The name is normalised and classified
 * before anything is written, so a rejected domain never occupies a row and the
 * administrator gets the specific reason rather than a generic refusal.
 *
 * A domain the organisation previously revoked is re-claimable: the exclusivity
 * indexes deliberately exclude `revoked`, so this creates a fresh `pending` row
 * beside the historical one rather than colliding with it.
 */
export const claimDomain = async (
  prisma: DomainServicePrisma,
  input: { organizationId: string; domain: string; createdByUserId: string | null },
  now = new Date(),
): Promise<{ id: string; domain: string; challenge: string }> => {
  const classified = classifyEmailDomain(input.domain, isPublicSuffix)
  if (!classified.ok) {
    throw new AutomaticMembershipDomainError(
      'This domain cannot be used for automatic team access.',
      'AUTOMATIC_MEMBERSHIP_DOMAIN_REJECTED',
      400,
      classified.reason,
    )
  }

  try {
    const created = await prisma.automaticMembershipDomain.create({
      data: {
        createdByUserId: input.createdByUserId,
        domain: classified.domain,
        organizationId: input.organizationId,
        status: 'pending',
        ...freshChallenge(now),
      },
      select: { challenge: true, domain: true, id: true },
    })
    return created
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Either this organisation already has a live claim on it, or another
      // organisation proved it first. Both are refusals; neither names the
      // other organisation.
      const mine = await prisma.automaticMembershipDomain.findFirst({
        where: {
          domain: classified.domain,
          organizationId: input.organizationId,
          status: { in: ['pending', 'verified', 'active', 'suspended'] },
        },
        select: { id: true },
      })
      if (mine) {
        throw new AutomaticMembershipDomainError(
          'This domain is already set up for this organisation.',
          'AUTOMATIC_MEMBERSHIP_DOMAIN_CLAIMED',
          409,
        )
      }
      throw claimedElsewhere()
    }
    throw error
  }
}

export type VerifyOutcome =
  | { kind: 'verified' }
  | { kind: 'first_observation' }
  | { kind: 'awaiting_second_observation'; readyAt: Date }
  | { kind: 'failed'; detail: string }
  | { kind: 'expired' }
  | { kind: 'claimed_elsewhere' }

/**
 * Run one DNS observation and apply it.
 *
 * A claim needs **two** successful observations at least ten minutes apart
 * before it becomes `verified` and takes the instance-wide lock, so a single
 * spoofed or cache-poisoned answer cannot lock the real owner out of their own
 * domain.
 */
export const verifyDomain = async (
  prisma: DomainServicePrisma,
  domainId: string,
  organizationId: string,
  dns: DomainVerificationDns = defaultDomainVerificationDns,
  now = new Date(),
): Promise<VerifyOutcome> => {
  const row = await prisma.automaticMembershipDomain.findFirst({
    where: { id: domainId, organizationId },
    select: {
      challenge: true,
      challengeExpiresAt: true,
      domain: true,
      firstSeenAt: true,
      status: true,
    },
  })
  if (!row) {
    throw new AutomaticMembershipDomainError('No such domain.', 'AUTOMATIC_MEMBERSHIP_NOT_FOUND', 404)
  }
  if (row.status === 'revoked') {
    throw new AutomaticMembershipDomainError(
      'This claim was released. Add the domain again to start over.',
      'AUTOMATIC_MEMBERSHIP_NOT_FOUND',
      404,
    )
  }

  // The lookup name is built from the STORED domain, never from caller input.
  const check = await checkDomainChallenge(row.domain, row.challenge, dns)
  const verdict = evaluateVerification({
    challengeExpiresAt: row.challengeExpiresAt,
    check,
    firstSeenAt: row.firstSeenAt,
    now,
  })

  const auditable: Prisma.AutomaticMembershipDomainUpdateInput = {
    lastCheckDetail: check.detail.slice(0, 500),
    lastCheckOutcome: check.outcome,
    lastCheckedAt: now,
  }

  if (verdict.kind === 'first_observation') {
    await prisma.automaticMembershipDomain.update({
      data: { ...auditable, firstSeenAt: now },
      where: { id: domainId },
    })
    return verdict
  }

  if (verdict.kind === 'verified') {
    // Already proven? A re-check on a proven domain is a revalidation, not a
    // re-verification: it must not demote an active one, and — the case missed
    // first time — it must not silently lift a suspension either. Resuming is
    // an explicit administrator act (§7's table has no suspended → verified
    // transition), so the check only clears the failure counter.
    if (row.status === 'active' || row.status === 'verified' || row.status === 'suspended') {
      await prisma.automaticMembershipDomain.update({
        data: { ...auditable, revalidationFailures: 0 },
        where: { id: domainId },
      })
      return verdict
    }
    try {
      await prisma.automaticMembershipDomain.update({
        data: { ...auditable, revalidationFailures: 0, status: 'verified', verifiedAt: now },
        where: { id: domainId },
      })
      return verdict
    } catch (error) {
      if (isUniqueViolation(error)) {
        await prisma.automaticMembershipDomain.update({ data: auditable, where: { id: domainId } })
        return { kind: 'claimed_elsewhere' }
      }
      throw error
    }
  }

  await prisma.automaticMembershipDomain.update({ data: auditable, where: { id: domainId } })
  return verdict
}

/**
 * Issue a new challenge. Any state can rotate, and rotating always returns the
 * claim to `pending`: the old record no longer proves anything, so continuing
 * to grant on it would be granting on a proof that has been withdrawn.
 */
export const rotateChallenge = async (
  prisma: DomainServicePrisma,
  domainId: string,
  organizationId: string,
  now = new Date(),
): Promise<string> => {
  const row = await prisma.automaticMembershipDomain.findFirst({
    select: { status: true },
    where: { id: domainId, organizationId },
  })
  if (!row || row.status === 'revoked') {
    throw new AutomaticMembershipDomainError('No such domain.', 'AUTOMATIC_MEMBERSHIP_NOT_FOUND', 404)
  }
  const updated = await prisma.automaticMembershipDomain.update({
    data: {
      ...freshChallenge(now),
      lastCheckDetail: null,
      lastCheckOutcome: null,
      revalidationFailures: 0,
      status: 'pending',
      verifiedAt: null,
    },
    select: { challenge: true },
    where: { id: domainId },
  })
  return updated.challenge
}

/**
 * Switch provisioning on or off for one domain. Activation requires a proven
 * claim; suspension is always allowed and never removes anybody — it only stops
 * future grants.
 */
export const setDomainStatus = async (
  prisma: DomainServicePrisma,
  domainId: string,
  organizationId: string,
  status: 'active' | 'suspended',
): Promise<void> => {
  const row = await prisma.automaticMembershipDomain.findFirst({
    select: { status: true },
    where: { id: domainId, organizationId },
  })
  if (!row || row.status === 'revoked') {
    throw new AutomaticMembershipDomainError('No such domain.', 'AUTOMATIC_MEMBERSHIP_NOT_FOUND', 404)
  }
  if (status === 'active' && row.status === 'pending') {
    throw new AutomaticMembershipDomainError(
      'Verify the DNS record before switching this on.',
      'AUTOMATIC_MEMBERSHIP_DNS_UNVERIFIED',
      409,
    )
  }
  await prisma.automaticMembershipDomain.update({ data: { status }, where: { id: domainId } })
}

/**
 * Release the claim. Rules are kept — they are the record of what was
 * configured, and the audit trail refers to them — but they are inert while the
 * domain is not `active`. Nobody is removed from any team: a released domain
 * stops future grants and nothing else.
 */
export const revokeDomain = async (
  prisma: DomainServicePrisma,
  domainId: string,
  organizationId: string,
): Promise<void> => {
  const updated = await prisma.automaticMembershipDomain.updateMany({
    data: { status: 'revoked', verifiedAt: null },
    where: { id: domainId, organizationId, status: { not: 'revoked' } },
  })
  if (updated.count === 0) {
    throw new AutomaticMembershipDomainError('No such domain.', 'AUTOMATIC_MEMBERSHIP_NOT_FOUND', 404)
  }
}

/** Exported for the route that echoes a normalised name back to the admin. */
export const normaliseForDisplay = (input: string): string | null => {
  const decision = normaliseDomain(input)
  return decision.ok ? decision.domain : null
}
