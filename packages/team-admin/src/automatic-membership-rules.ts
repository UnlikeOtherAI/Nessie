/**
 * Reading and matching automatic-membership rules, shared by the api (which
 * matches at sign-in, with the address in hand) and the worker (which
 * re-checks before every grant and every reconciliation batch).
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md.
 *
 * Nothing here stores an email. `matchAutomaticMembershipRules` takes one,
 * derives its domain in memory and returns rule ids; the address never reaches
 * a column or a queue payload.
 */

import type { PrismaClient } from '@prisma/client'
import { classifyEmailDomain, domainOfEmail, AUTOMATIC_MEMBERSHIP_SETTING_KEY } from '@nessie/schemas'
import { isPublicSuffix, resolveScopedSetting } from '@nessie/runtime'

import type { AutomaticGrantRule } from './automatic-membership-grant.js'

export type AutomaticMembershipPrisma = Pick<
  PrismaClient,
  'automaticMembershipDomain' | 'automaticMembershipRule' | 'scopedSetting'
>

/**
 * The organisation's emergency stop.
 *
 * Resolved with `{ organizationId }` and nothing else, deliberately: the
 * scoped-setting cascade is most-specific-wins, so passing a team or user id
 * would let a lower tier re-enable what an organisation turned off.
 *
 * Absent means enabled. That is stated rather than dressed up as fail-closed —
 * an organisation that never touched the switch must not have to opt in twice.
 * The fail-closed gate is the instance flag, which defaults off.
 */
export const isAutomaticMembershipEnabledForOrganization = async (
  prisma: Pick<PrismaClient, 'scopedSetting'>,
  organizationId: string,
): Promise<boolean> => {
  const resolved = await resolveScopedSetting<boolean>(
    prisma,
    { organizationId },
    AUTOMATIC_MEMBERSHIP_SETTING_KEY,
  )
  return resolved.value !== false
}

/**
 * Which rules an address matches right now.
 *
 * Exact domain match only — a claim on `example.com` says nothing about
 * `sub.example.com`, which needs its own claim. The classifier runs again here
 * and not only at claim time, so a domain that became a known consumer
 * provider after a list update stops granting at the next sign-in rather than
 * at the next claim.
 */
export const matchAutomaticMembershipRules = async (
  prisma: AutomaticMembershipPrisma,
  input: { organizationId: string; email: string; emailVerified?: boolean },
): Promise<string[]> => {
  // UOA does not assert `email_verified` today. When it starts, an explicit
  // `false` is a refusal — the same rule the generic-OIDC branch already
  // applies. Absent stays permitted; the trust basis is active membership of
  // the UOA organisation, which is what the manual "Add member" button uses.
  if (input.emailVerified === false) return []

  const domain = domainOfEmail(input.email)
  if (!domain) return []
  if (!classifyEmailDomain(domain, isPublicSuffix).ok) return []

  const rules = await prisma.automaticMembershipRule.findMany({
    where: {
      domain: {
        domain,
        organizationId: input.organizationId,
        status: 'active',
      },
      enabled: true,
      healthState: 'ok',
    },
    select: { id: true },
  })
  return rules.map((rule) => rule.id)
}

/**
 * Load one rule as a grant target, re-checking every precondition. Returns null
 * when the rule has since been disabled, its domain suspended or revoked, its
 * authorization lost, or its team unbound from UOA — so a job enqueued minutes
 * ago cannot act on a policy that has since changed.
 */
export const loadAutomaticGrantRule = async (
  prisma: Pick<PrismaClient, 'automaticMembershipRule'>,
  ruleId: string,
  organizationId: string,
): Promise<AutomaticGrantRule | null> => {
  const rule = await prisma.automaticMembershipRule.findFirst({
    where: {
      domain: { organizationId, status: 'active' },
      enabled: true,
      healthState: 'ok',
      id: ruleId,
    },
    select: {
      authorizedByUoaSub: true,
      authorizedTeamId: true,
      authorizedTokenVersion: true,
      domain: { select: { domain: true } },
      id: true,
      team: { select: { externalOrgId: true, externalTeamId: true, id: true, name: true } },
    },
  })
  if (!rule?.team.externalOrgId || !rule.team.externalTeamId) return null
  // The classifier is re-applied to the stored domain, so a list change
  // suspends granting without needing a migration or an admin visit.
  if (!classifyEmailDomain(rule.domain.domain, isPublicSuffix).ok) return null

  return {
    authorizedByUoaSub: rule.authorizedByUoaSub,
    authorizedTeamId: rule.authorizedTeamId,
    authorizedTokenVersion: rule.authorizedTokenVersion,
    externalOrgId: rule.team.externalOrgId,
    externalTeamId: rule.team.externalTeamId,
    id: rule.id,
    teamId: rule.team.id,
    teamName: rule.team.name,
  }
}
