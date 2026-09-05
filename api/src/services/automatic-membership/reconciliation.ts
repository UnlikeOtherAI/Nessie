/**
 * Reconciliation runs: placing people who already matched a rule before it
 * existed. Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §10.
 *
 * A run is durable and resumable because it walks the whole organisation roster
 * a page at a time and can take hours. Starting a new run supersedes any run
 * still in flight for the same domain, which is also how a rule change cancels
 * work that was based on the old rule set.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import { AUTOMATIC_MEMBERSHIP_RECONCILE_TOPIC } from '@nessie/schemas'

import { AutomaticMembershipDomainError } from './domains.js'
import type { RuleAuthorization } from './rules.js'

export type ReconciliationPrisma = Pick<
  PrismaClient,
  'automaticMembershipDomain' | 'automaticMembershipReconciliation' | 'automaticMembershipRule'
> & { $executeRaw: PrismaClient['$executeRaw'] }

export const IN_FLIGHT_STATUSES = ['queued', 'running'] as const

/**
 * Start a run for one domain, superseding whatever was in flight.
 *
 * The run records the principal each batch mints its assertion for, so
 * authorization is re-resolved upstream on every batch rather than assumed at
 * the start — an administrator who loses access mid-run stops it.
 */
export const startReconciliation = async (
  prisma: ReconciliationPrisma,
  input: {
    domainId: string
    organizationId: string
    authorization: RuleAuthorization
    requestedByUserId: string | null
  },
): Promise<{ id: string; ruleIds: string[] } | null> => {
  const domain = await prisma.automaticMembershipDomain.findFirst({
    select: { id: true, status: true },
    where: { id: input.domainId, organizationId: input.organizationId },
  })
  if (!domain) {
    throw new AutomaticMembershipDomainError('No such domain.', 'AUTOMATIC_MEMBERSHIP_NOT_FOUND', 404)
  }
  if (domain.status !== 'active') {
    throw new AutomaticMembershipDomainError(
      'Switch this domain on before adding existing people.',
      'AUTOMATIC_MEMBERSHIP_DNS_UNVERIFIED',
      409,
    )
  }

  const rules = await prisma.automaticMembershipRule.findMany({
    select: { id: true },
    where: { domainId: input.domainId, enabled: true, healthState: 'ok' },
  })
  // Nothing to reconcile is not an error; it is a domain with no teams yet.
  if (rules.length === 0) return null

  await prisma.automaticMembershipReconciliation.updateMany({
    data: { finishedAt: new Date(), status: 'superseded' },
    where: { domainId: input.domainId, status: { in: [...IN_FLIGHT_STATUSES] } },
  })

  const run = await prisma.automaticMembershipReconciliation.create({
    data: {
      authorizedByUoaSub: input.authorization.authorizedByUoaSub,
      authorizedTeamId: input.authorization.authorizedTeamId,
      authorizedTokenVersion: input.authorization.authorizedTokenVersion,
      domainId: input.domainId,
      requestedByUserId: input.requestedByUserId,
      ruleIds: rules.map((rule) => rule.id),
      status: 'queued',
    },
    select: { id: true, ruleIds: true },
  })

  await enqueueQueueJob(prisma, {
    idempotencyKey: `auto-membership:reconcile:${run.id}:0`,
    payload: { organizationId: input.organizationId, reconciliationId: run.id },
    topic: AUTOMATIC_MEMBERSHIP_RECONCILE_TOPIC,
  })

  return run
}

/**
 * Stop a run. The batch loop re-reads its own row before every page, so a
 * cancelled run stops at its next page boundary rather than mid-call — the work
 * already done stands, and nobody is un-added.
 */
export const cancelReconciliation = async (
  prisma: Pick<PrismaClient, 'automaticMembershipReconciliation'>,
  input: { reconciliationId: string; organizationId: string },
): Promise<void> => {
  const cancelled = await prisma.automaticMembershipReconciliation.updateMany({
    data: { finishedAt: new Date(), status: 'cancelled' },
    where: {
      domain: { organizationId: input.organizationId },
      id: input.reconciliationId,
      status: { in: [...IN_FLIGHT_STATUSES] },
    },
  })
  if (cancelled.count === 0) {
    throw new AutomaticMembershipDomainError(
      'That run has already finished.',
      'AUTOMATIC_MEMBERSHIP_NOT_FOUND',
      404,
    )
  }
}

/**
 * Supersede in-flight runs for a domain whose rules just changed, so a run
 * cannot keep granting against a team set an administrator has removed.
 */
export const supersedeReconciliations = async (
  prisma: Pick<PrismaClient, 'automaticMembershipReconciliation'>,
  domainId: string,
  transaction?: Prisma.TransactionClient,
): Promise<void> => {
  const client = transaction ?? prisma
  await client.automaticMembershipReconciliation.updateMany({
    data: { finishedAt: new Date(), status: 'superseded' },
    where: { domainId, status: { in: [...IN_FLIGHT_STATUSES] } },
  })
}
