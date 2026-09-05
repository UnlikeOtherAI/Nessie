/**
 * Periodic DNS revalidation, and the sweep that schedules it.
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §7.
 *
 * The cadence is a short tick that asks "is one due?" rather than a long
 * `setInterval`. Every existing sweep in `worker/src/index.ts` ticks in seconds
 * to minutes for exactly this reason: a 24-hour timer never fires in a
 * deployment that redeploys more often than that, and this is the control that
 * catches a domain leaving the organisation's hands.
 */

import type { PrismaClient } from '@prisma/client'
import {
  AUTOMATIC_MEMBERSHIP_REVALIDATE_TOPIC,
  type AutomaticMembershipRevalidateJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'
import {
  checkDomainChallenge,
  defaultDomainVerificationDns,
  REVALIDATION_FAILURE_LIMIT,
  REVALIDATION_INTERVAL_MS,
  type DomainVerificationDns,
} from '@nessie/team-admin'

import { writeAutomaticMembershipAudit } from './audit.js'

/** How often the tick looks for due domains. */
export const REVALIDATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000

const SWEEP_LIMIT = 100

/**
 * Enqueue a revalidation for each domain whose last check is older than a day.
 * The idempotency key is bucketed by the sweep window so several replicas
 * ticking together enqueue one job per domain per window, the same shape
 * `enqueueCommsSubscriptionsRenew` uses.
 */
export const sweepDueDomainRevalidations = async (
  prisma: PrismaClient,
  now = new Date(),
): Promise<number> => {
  const due = await prisma.automaticMembershipDomain.findMany({
    orderBy: { lastCheckedAt: 'asc' },
    select: { id: true },
    take: SWEEP_LIMIT,
    where: {
      status: { in: ['active', 'suspended'] },
      OR: [
        { lastCheckedAt: null },
        { lastCheckedAt: { lt: new Date(now.getTime() - REVALIDATION_INTERVAL_MS) } },
      ],
    },
  })

  const bucket = Math.floor(now.getTime() / REVALIDATION_SWEEP_INTERVAL_MS)
  for (const domain of due) {
    await enqueueQueueJob(prisma, {
      idempotencyKey: `auto-membership:revalidate:${domain.id}:${bucket}`,
      payload: { domainId: domain.id },
      topic: AUTOMATIC_MEMBERSHIP_REVALIDATE_TOPIC,
    })
  }
  return due.length
}

/**
 * Re-check one domain's TXT record.
 *
 * Three consecutive failures suspend provisioning. Suspension stops future
 * grants and removes nobody — a domain that briefly loses its record must not
 * cost people the teams they are already working in.
 */
export const executeAutomaticMembershipRevalidateJob = async (
  deps: { prisma: PrismaClient; dns?: DomainVerificationDns },
  payload: AutomaticMembershipRevalidateJobPayload,
): Promise<void> => {
  const { prisma } = deps
  const domain = await prisma.automaticMembershipDomain.findUnique({
    where: { id: payload.domainId },
    select: {
      challenge: true,
      domain: true,
      id: true,
      organizationId: true,
      revalidationFailures: true,
      status: true,
    },
  })
  if (!domain || (domain.status !== 'active' && domain.status !== 'suspended')) return

  const check = await checkDomainChallenge(
    domain.domain,
    domain.challenge,
    deps.dns ?? defaultDomainVerificationDns,
  )
  const now = new Date()

  if (check.outcome === 'match') {
    await prisma.automaticMembershipDomain.update({
      data: {
        lastCheckDetail: check.detail.slice(0, 500),
        lastCheckOutcome: check.outcome,
        lastCheckedAt: now,
        revalidationFailures: 0,
      },
      where: { id: domain.id },
    })
    return
  }

  const failures = domain.revalidationFailures + 1
  const suspend = failures >= REVALIDATION_FAILURE_LIMIT && domain.status === 'active'
  await prisma.automaticMembershipDomain.update({
    data: {
      lastCheckDetail: check.detail.slice(0, 500),
      lastCheckOutcome: check.outcome,
      lastCheckedAt: now,
      revalidationFailures: failures,
      ...(suspend ? { status: 'suspended' as const } : {}),
    },
    where: { id: domain.id },
  })

  await writeAutomaticMembershipAudit(prisma, {
    action: 'organization.automatic_membership.dns_checked',
    metadata: { domain: domain.domain, failures, outcome: check.outcome },
    organizationId: domain.organizationId,
    outcome: 'denied',
    reason: check.detail,
    resourceId: domain.id,
    resourceType: 'automatic_membership_domain',
  })

  if (suspend) {
    // A state that names its remedy, per
    // docs/standards/capability-health-alerts.md: the panel shows the failing
    // record and the administrator republishes it and resumes explicitly.
    await writeAutomaticMembershipAudit(prisma, {
      action: 'organization.automatic_membership.domain_suspended',
      metadata: { domain: domain.domain, reason: 'dns_revalidation_failed' },
      organizationId: domain.organizationId,
      outcome: 'denied',
      reason: check.detail,
      resourceId: domain.id,
      resourceType: 'automatic_membership_domain',
    })
  }
}
