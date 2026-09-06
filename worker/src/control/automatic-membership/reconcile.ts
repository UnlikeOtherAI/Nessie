/**
 * Reconciliation: place people who already matched a rule before it existed.
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §10.
 *
 * One job per page, self-continuing, following the cross-job cursor shape
 * `executeCommsIncrementalSweepJob` established. Three properties are the point:
 *
 *  - **Authorization is re-checked before every batch, by mechanism.** Each
 *    page mints a fresh org-scoped subject assertion for the administrator who
 *    started the run, and UOA re-resolves their live role to answer. An
 *    administrator who loses access mid-run stops the run.
 *  - **Supersession and cancellation are the same mechanism.** The run row is
 *    re-read before every page; a rule change supersedes it and an administrator
 *    can cancel it, and either way it stops at the next page boundary. Work
 *    already done stands — nobody is ever un-added.
 *  - **Replay is free.** The grant ledger means a resumed, restarted or
 *    duplicated run grants nobody twice, which is what lets a rejected cursor
 *    restart from the beginning instead of failing the run.
 */

import type { PrismaClient } from '@prisma/client'
import {
  AUTOMATIC_MEMBERSHIP_RECONCILE_TOPIC,
  domainOfEmail,
  type AutomaticMembershipReconcileJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'
import { createUoaSubjectAssertion } from '@nessie/runtime'
import { exponentialBackoffMs } from '@nessie/runtime/scheduling'
import {
  defaultAutomaticGrantUpstream,
  grantAutomaticMembership,
  isAutomaticMembershipEnabledForOrganization,
  listOrganisationMembers,
  loadAutomaticGrantRule,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  delegatedSettings,
  type AutomaticGrantRule,
  type UoaRosterDeps,
} from '@nessie/team-admin'

import { writeAutomaticMembershipAudit } from './audit.js'
import { alertAutomaticMembershipHealth } from './health-alert.js'
import { awaitUpstreamSlot } from './rate-limit.js'
import type { AutomaticMembershipDeps } from './provision.js'

const PAGE_SIZE = 50
const BATCH_PAUSE_MS = 1_000
const MAX_ATTEMPTS = 5

/**
 * Enqueue the next unit of this run, keyed on a counter that only ever goes up.
 *
 * The first cut keyed retries on `attempts` (which is reset after every
 * successful page) and pages on the cursor (which a restart re-walks). Both
 * reuse keys, and `queue_jobs.idempotency_key` is uniquely indexed with an
 * ON CONFLICT DO NOTHING insert that nothing ever purges — so a reused key
 * enqueues nothing at all and leaves the run `running` for good. The boolean is
 * checked here for the same reason: silently enqueueing nothing is exactly the
 * failure being fixed.
 */
const enqueueNextStep = async (
  prisma: PrismaClient,
  payload: AutomaticMembershipReconcileJobPayload,
  delayMs?: number,
): Promise<boolean> => {
  const advanced = await prisma.automaticMembershipReconciliation.update({
    data: { step: { increment: 1 } },
    select: { step: true },
    where: { id: payload.reconciliationId },
  })
  return enqueueQueueJob(prisma, {
    ...(delayMs === undefined ? {} : { delayMs }),
    idempotencyKey: `auto-membership:reconcile:${payload.reconciliationId}:${advanced.step}`,
    payload,
    topic: AUTOMATIC_MEMBERSHIP_RECONCILE_TOPIC,
  })
}

const finish = async (
  prisma: PrismaClient,
  runId: string,
  status: 'completed' | 'failed',
  lastError?: string,
): Promise<void> => {
  await prisma.automaticMembershipReconciliation.updateMany({
    data: {
      finishedAt: new Date(),
      status,
      ...(lastError ? { lastError: lastError.slice(0, 500) } : {}),
    },
    where: { id: runId, status: { in: ['queued', 'running'] } },
  })
}

/** The run's own principal, minted fresh for this page. */
const assertionDepsFor = (
  run: { authorizedByUoaSub: string; authorizedTeamId: string; authorizedTokenVersion: number },
  externalOrgId: string,
  deps: UoaRosterDeps,
): UoaRosterDeps => {
  const settings = delegatedSettings()
  return {
    ...deps,
    subjectAssertion: createUoaSubjectAssertion(
      settings,
      {
        organizationId: externalOrgId,
        subject: run.authorizedByUoaSub,
        teamId: run.authorizedTeamId,
        tokenVersion: run.authorizedTokenVersion,
      },
      `${settings.authBaseUrl}/org`,
    ),
  }
}

export const executeAutomaticMembershipReconcileJob = async (
  deps: AutomaticMembershipDeps,
  payload: AutomaticMembershipReconcileJobPayload,
): Promise<void> => {
  const { prisma } = deps
  if (!deps.enabled) return

  const run = await prisma.automaticMembershipReconciliation.findUnique({
    where: { id: payload.reconciliationId },
    select: {
      attempts: true,
      authorizedByUoaSub: true,
      authorizedTeamId: true,
      authorizedTokenVersion: true,
      cursor: true,
      domainId: true,
      failed: true,
      granted: true,
      matched: true,
      ruleIds: true,
      scanned: true,
      skipped: true,
      status: true,
      step: true,
      domain: {
        select: {
          domain: true,
          organizationId: true,
          status: true,
          organization: { select: { externalOrgId: true } },
        },
      },
    },
  })

  // Superseded, cancelled or already finished: stop, silently and completely.
  if (!run || (run.status !== 'queued' && run.status !== 'running')) return

  const externalOrgId = run.domain.organization.externalOrgId
  if (!externalOrgId || run.domain.status !== 'active') {
    await finish(prisma, payload.reconciliationId, 'failed', 'The domain is no longer active.')
    return
  }
  if (!(await isAutomaticMembershipEnabledForOrganization(prisma, run.domain.organizationId))) {
    await finish(prisma, payload.reconciliationId, 'failed', 'Automatic access is switched off.')
    return
  }

  // Re-resolve the rules this run was started for. A rule that has since been
  // removed, disabled or lost its authorization simply drops out.
  const rules: AutomaticGrantRule[] = []
  for (const ruleId of run.ruleIds) {
    const rule = await loadAutomaticGrantRule(prisma, ruleId, run.domain.organizationId)
    if (rule) rules.push(rule)
  }
  if (rules.length === 0) {
    await finish(prisma, payload.reconciliationId, 'completed')
    return
  }

  await prisma.automaticMembershipReconciliation.updateMany({
    data: { startedAt: new Date(), status: 'running' },
    where: { id: payload.reconciliationId, status: 'queued' },
  })

  const assertionDeps = assertionDepsFor(run, externalOrgId, deps.rosterDeps ?? {})

  let page
  try {
    await awaitUpstreamSlot(prisma, run.domain.organizationId)
    page = await listOrganisationMembers(
      externalOrgId,
      { limit: PAGE_SIZE, status: 'ACTIVE', ...(run.cursor ? { cursor: run.cursor } : {}) },
      assertionDeps,
    )
  } catch (error) {
    if (error instanceof UoaRosterUnavailableError && run.attempts + 1 < MAX_ATTEMPTS) {
      // Transient: re-enqueue this exact page after a backoff.
      await prisma.automaticMembershipReconciliation.update({
        data: { attempts: { increment: 1 }, lastError: error.message.slice(0, 500) },
        where: { id: payload.reconciliationId },
      })
      const queued = await enqueueNextStep(
        prisma,
        payload,
        exponentialBackoffMs({ attempt: run.attempts, baseMs: 30_000, capMs: 30 * 60_000 }),
      )
      if (!queued) {
        await finish(prisma, payload.reconciliationId, 'failed', 'Could not queue the next batch.')
      }
      return
    }
    if (error instanceof UoaRosterRejectedError && error.statusCode === 400 && run.cursor) {
      // A keyset cursor can go stale over an hours-long walk of a mutating
      // roster. Restarting is safe precisely because the ledger makes a second
      // pass grant nobody twice.
      await prisma.automaticMembershipReconciliation.update({
        data: { attempts: { increment: 1 }, cursor: null },
        where: { id: payload.reconciliationId },
      })
      const queued = await enqueueNextStep(prisma, payload)
      if (!queued) {
        await finish(prisma, payload.reconciliationId, 'failed', 'Could not queue the next batch.')
      }
      return
    }
    const message = error instanceof Error ? error.message : 'unknown error'
    await finish(prisma, payload.reconciliationId, 'failed', message)
    await writeAutomaticMembershipAudit(prisma, {
      action: 'organization.automatic_membership.reconcile_finished',
      metadata: { status: 'failed' },
      organizationId: run.domain.organizationId,
      outcome: 'error',
      reason: message,
      resourceId: payload.reconciliationId,
      resourceType: 'automatic_membership_reconciliation',
    })
    return
  }

  let { failed, granted, matched, scanned, skipped } = run
  for (const member of page.items) {
    scanned += 1
    // Exact domain match only, from the address UOA reports right now — never
    // from a copied cache. `status: 'ACTIVE'` was asked of UOA, and is
    // re-checked here because a filter the server may ignore is not a guarantee.
    if (member.status && member.status !== 'ACTIVE') continue
    if (!member.email || domainOfEmail(member.email) !== run.domain.domain) continue
    matched += 1

    for (const rule of rules) {
        const result = await grantAutomaticMembership(
        prisma,
        rule,
        member.uoaSub,
        'reconcile',
        deps.rosterDeps ?? {},
        {
          ...defaultAutomaticGrantUpstream,
          pace: () => awaitUpstreamSlot(prisma, run.domain.organizationId),
        },
      )
      if (result.outcome === 'granted') {
        granted += 1
        await writeAutomaticMembershipAudit(prisma, {
          action: 'organization.automatic_membership.grant_issued',
          metadata: {
            authorizedByUoaSub: rule.authorizedByUoaSub,
            source: 'reconcile',
            teamId: rule.teamId,
            uoaSub: member.uoaSub,
          },
          organizationId: run.domain.organizationId,
          outcome: 'success',
          resourceId: rule.id,
          resourceType: 'automatic_membership_rule',
        })
      }
      else if (
        result.outcome === 'skipped_existing'
        || result.outcome === 'skipped_no_such_team'
        || result.outcome === 'in_flight'
      ) skipped += 1
      else failed += 1

      if (result.outcome === 'unauthorized') {
        // The run's principal no longer holds access. Stop the whole run rather
        // than grinding through thousands of refusals.
        if (result.healthTransition) {
          await alertAutomaticMembershipHealth(prisma, {
            healthRevision: result.healthTransition.healthRevision,
            organizationId: run.domain.organizationId,
            reason: result.reason ?? 'UnlikeOtherAI refused the authorizing administrator.',
            ruleId: rule.id,
            teamName: rule.teamName,
          })
        }
        await writeAutomaticMembershipAudit(prisma, {
          action: 'organization.automatic_membership.rule_needs_reauthorization',
          metadata: { teamId: rule.teamId },
          organizationId: run.domain.organizationId,
          outcome: 'denied',
          reason: result.reason,
          resourceId: rule.id,
          resourceType: 'automatic_membership_rule',
        })
        await prisma.automaticMembershipReconciliation.update({
          data: { failed, granted, matched, scanned, skipped },
          where: { id: payload.reconciliationId },
        })
        await finish(
          prisma,
          payload.reconciliationId,
          'failed',
          'The administrator who started this run no longer has access.',
        )
        return
      }
    }
  }

  await prisma.automaticMembershipReconciliation.update({
    data: {
      attempts: 0,
      cursor: page.meta.nextCursor ?? null,
      failed,
      granted,
      matched,
      scanned,
      skipped,
    },
    where: { id: payload.reconciliationId },
  })

  if (page.meta.hasMore && page.meta.nextCursor) {
    const queued = await enqueueNextStep(prisma, payload, BATCH_PAUSE_MS)
    if (!queued) {
      await finish(prisma, payload.reconciliationId, 'failed', 'Could not queue the next batch.')
    }
    return
  }

  await finish(prisma, payload.reconciliationId, 'completed')
  await writeAutomaticMembershipAudit(prisma, {
    action: 'organization.automatic_membership.reconcile_finished',
    metadata: { failed, granted, matched, scanned, skipped, status: 'completed' },
    organizationId: run.domain.organizationId,
    outcome: 'success',
    resourceId: payload.reconciliationId,
    resourceType: 'automatic_membership_reconciliation',
  })
}
