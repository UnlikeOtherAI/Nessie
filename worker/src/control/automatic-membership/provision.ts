/**
 * Sign-in provisioning: place one person into the teams their email domain
 * grants. Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §8.
 *
 * The match already happened in the login path, with the address in hand; this
 * job only executes it. It re-reads every precondition first, so a job enqueued
 * a minute ago cannot act on a policy an administrator has since changed.
 */

import type { PrismaClient } from '@prisma/client'
import type { AutomaticMembershipProvisionJobPayload } from '@nessie/schemas'
import {
  defaultAutomaticGrantUpstream,
  grantAutomaticMembership,
  isAutomaticMembershipEnabledForOrganization,
  loadAutomaticGrantRule,
  type UoaRosterDeps,
} from '@nessie/team-admin'

import { writeAutomaticMembershipAudit } from './audit.js'
import { alertAutomaticMembershipHealth } from './health-alert.js'
import { awaitUpstreamSlot } from './rate-limit.js'

export type AutomaticMembershipDeps = {
  prisma: PrismaClient
  /**
   * The instance rollout flag. Checked here and not only in the routes: the
   * routes 404 when it is off, which also hides the per-organisation emergency
   * stop, so an operator who switches the feature off at the instance level
   * would otherwise have no way to stop workers granting on existing rules.
   */
  enabled: boolean
  rosterDeps?: UoaRosterDeps
}

export const executeAutomaticMembershipProvisionJob = async (
  deps: AutomaticMembershipDeps,
  payload: AutomaticMembershipProvisionJobPayload,
): Promise<void> => {
  const { prisma } = deps
  if (!deps.enabled) return

  // The organisation's emergency stop, re-read here and not cached: turning it
  // off must stop work already queued, not only work not yet queued.
  if (!(await isAutomaticMembershipEnabledForOrganization(prisma, payload.organizationId))) {
    return
  }

  for (const ruleId of payload.ruleIds) {
    // Re-checked per rule: enabled, domain active, authorization intact, team
    // still UOA-bound, domain still passing the classifier.
    const rule = await loadAutomaticGrantRule(prisma, ruleId, payload.organizationId)
    if (!rule) continue

    const result = await grantAutomaticMembership(
      prisma,
      rule,
      payload.uoaSub,
      'signin',
      deps.rosterDeps ?? {},
      { ...defaultAutomaticGrantUpstream, pace: () => awaitUpstreamSlot(payload.organizationId) },
    )

    // `grant_issued` is written only when a grant actually happened. Auditing a
    // skip under that name would claim membership changed when it did not.
    if (result.outcome === 'granted') {
      await writeAutomaticMembershipAudit(prisma, {
        action: 'organization.automatic_membership.grant_issued',
        metadata: {
          authorizedByUoaSub: rule.authorizedByUoaSub,
          source: 'signin',
          teamId: rule.teamId,
          uoaSub: payload.uoaSub,
        },
        organizationId: payload.organizationId,
        outcome: 'success',
        resourceId: rule.id,
        resourceType: 'automatic_membership_rule',
      })
      continue
    }
    if (result.outcome === 'skipped_existing') continue

    if (result.outcome === 'unauthorized') {
      if (result.healthTransition) {
        await alertAutomaticMembershipHealth(prisma, {
          healthRevision: result.healthTransition.healthRevision,
          organizationId: payload.organizationId,
          reason: result.reason ?? 'UnlikeOtherAI refused the authorizing administrator.',
          ruleId: rule.id,
          teamName: rule.teamName,
        })
      }
      await writeAutomaticMembershipAudit(prisma, {
        action: 'organization.automatic_membership.rule_needs_reauthorization',
        metadata: { authorizedByUoaSub: rule.authorizedByUoaSub, teamId: rule.teamId },
        organizationId: payload.organizationId,
        outcome: 'denied',
        reason: result.reason,
        resourceId: rule.id,
        resourceType: 'automatic_membership_rule',
      })
      continue
    }

    if (result.outcome === 'failed') {
      // Transport or 5xx. The ledger row's lease was released, so the person's
      // next sign-in retries this rule rather than being permanently skipped.
      console.warn(
        `automatic membership: grant deferred for rule ${rule.id}: ${result.reason ?? 'unknown'}`,
      )
    }
  }
}
