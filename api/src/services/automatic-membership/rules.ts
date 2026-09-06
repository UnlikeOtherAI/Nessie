/**
 * Grant rules: which teams a verified domain places people into.
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §4.2, §4.6.
 *
 * A rule records the administrator who authorized it. Every grant it later
 * makes mints a fresh org-scoped subject assertion for that subject, so UOA
 * re-resolves their live role at that moment. Re-authorization therefore is not
 * bookkeeping: it is the act that gives a rule a currently-valid principal.
 */

import type { PrismaClient } from '@prisma/client'

import { AutomaticMembershipDomainError } from './domains.js'
import type { RuleAuthorization } from './access.js'

export type RuleServicePrisma = Pick<
  PrismaClient,
  'automaticMembershipDomain' | 'automaticMembershipRule' | 'team'
>

export type RuleChange = {
  added: { id: string; teamId: string }[]
  removed: { id: string; teamId: string }[]
}

const requireDomain = async (
  prisma: RuleServicePrisma,
  domainId: string,
  organizationId: string,
): Promise<{ id: string; status: string }> => {
  const domain = await prisma.automaticMembershipDomain.findFirst({
    select: { id: true, status: true },
    where: { id: domainId, organizationId, status: { not: 'revoked' } },
  })
  if (!domain) {
    throw new AutomaticMembershipDomainError('No such domain.', 'AUTOMATIC_MEMBERSHIP_NOT_FOUND', 404)
  }
  return domain
}

/** Teams that exist in this organisation, are UOA-bound, and are not system-managed. */
const assertTeamsBelong = async (
  prisma: RuleServicePrisma,
  organizationId: string,
  teamIds: readonly string[],
): Promise<void> => {
  if (teamIds.length === 0) return
  const found = await prisma.team.findMany({
    select: { id: true },
    where: {
      externalTeamId: { not: null },
      id: { in: [...teamIds] },
      project: { organizationId },
      systemManaged: false,
    },
  })
  if (found.length !== new Set(teamIds).size) {
    throw new AutomaticMembershipDomainError(
      'One of those teams is not part of this organisation.',
      'AUTOMATIC_MEMBERSHIP_NOT_FOUND',
      404,
    )
  }
}

/**
 * Replace a domain's team set — the organisation surface's checkbox save.
 *
 * Rules that are already present and still selected are left alone, so their
 * grant ledger and their authorization survive a save that did not concern
 * them. Only the difference is written.
 */
export const setDomainTeams = async (
  prisma: RuleServicePrisma,
  input: {
    domainId: string
    organizationId: string
    teamIds: readonly string[]
    authorization: RuleAuthorization
    createdByUserId: string | null
  },
): Promise<RuleChange> => {
  await requireDomain(prisma, input.domainId, input.organizationId)
  await assertTeamsBelong(prisma, input.organizationId, input.teamIds)

  const existing = await prisma.automaticMembershipRule.findMany({
    select: { enabled: true, id: true, teamId: true },
    where: { domainId: input.domainId },
  })
  const wanted = new Set(input.teamIds)
  const present = new Map(existing.map((rule) => [rule.teamId, rule]))

  const removed = existing.filter((rule) => rule.enabled && !wanted.has(rule.teamId))
  const toAdd = [...wanted].filter((teamId) => !present.has(teamId))
  const toReEnable = [...wanted].filter((teamId) => present.get(teamId)?.enabled === false)

  if (removed.length > 0) {
    // Detaching DISABLES rather than deletes. Deleting cascades the grant
    // ledger, which would lose the record of who was placed and make a
    // re-attach re-walk everybody. Nobody is removed from the team either way —
    // removal stays an explicit, manual act.
    await prisma.automaticMembershipRule.updateMany({
      data: { enabled: false },
      where: { id: { in: removed.map((rule) => rule.id) } },
    })
  }

  const added: { id: string; teamId: string }[] = []
  for (const teamId of toReEnable) {
    const rule = present.get(teamId)
    if (!rule) continue
    await prisma.automaticMembershipRule.update({
      data: {
        authorizedAt: new Date(),
        authorizedByUoaSub: input.authorization.authorizedByUoaSub,
        authorizedTeamId: input.authorization.authorizedTeamId,
        authorizedTokenVersion: input.authorization.authorizedTokenVersion,
        enabled: true,
        healthReason: null,
        healthState: 'ok',
      },
      where: { id: rule.id },
    })
    added.push({ id: rule.id, teamId })
  }
  for (const teamId of toAdd) {
    const created = await prisma.automaticMembershipRule.create({
      data: {
        authorizedAt: new Date(),
        authorizedByUoaSub: input.authorization.authorizedByUoaSub,
        authorizedTeamId: input.authorization.authorizedTeamId,
        authorizedTokenVersion: input.authorization.authorizedTokenVersion,
        createdByUserId: input.createdByUserId,
        createdScope: 'organization',
        domainId: input.domainId,
        teamId,
      },
      select: { id: true, teamId: true },
    })
    added.push(created)
  }

  return { added, removed }
}

/**
 * The team surface's toggle: attach or detach exactly one team. The caller has
 * already been proven a administrator of that team, and of no other, so this
 * never touches another team's rule.
 */
export const setTeamRule = async (
  prisma: RuleServicePrisma,
  input: {
    domainId: string
    organizationId: string
    teamId: string
    enabled: boolean
    authorization: RuleAuthorization
    createdByUserId: string | null
  },
): Promise<RuleChange> => {
  const domain = await requireDomain(prisma, input.domainId, input.organizationId)
  await assertTeamsBelong(prisma, input.organizationId, [input.teamId])

  const existing = await prisma.automaticMembershipRule.findUnique({
    select: { enabled: true, id: true, teamId: true },
    where: { domainId_teamId: { domainId: input.domainId, teamId: input.teamId } },
  })

  if (!input.enabled) {
    if (!existing?.enabled) return { added: [], removed: [] }
    // Disabled, not deleted — see `setDomainTeams`.
    await prisma.automaticMembershipRule.update({
      data: { enabled: false },
      where: { id: existing.id },
    })
    return { added: [], removed: [{ id: existing.id, teamId: existing.teamId }] }
  }

  if (existing) {
    // Re-affirming an existing rule refreshes its principal, which is what a
    // team admin re-enabling it should mean.
    await prisma.automaticMembershipRule.update({
      data: {
        authorizedAt: new Date(),
        authorizedByUoaSub: input.authorization.authorizedByUoaSub,
        authorizedTeamId: input.authorization.authorizedTeamId,
        authorizedTokenVersion: input.authorization.authorizedTokenVersion,
        enabled: true,
        healthReason: null,
        healthState: 'ok',
      },
      where: { id: existing.id },
    })
    return existing.enabled
      ? { added: [], removed: [] }
      : { added: [{ id: existing.id, teamId: existing.teamId }], removed: [] }
  }

  if (domain.status === 'pending') {
    throw new AutomaticMembershipDomainError(
      'This domain has not been verified yet.',
      'AUTOMATIC_MEMBERSHIP_DNS_UNVERIFIED',
      409,
    )
  }

  const created = await prisma.automaticMembershipRule.create({
    data: {
      authorizedAt: new Date(),
      authorizedByUoaSub: input.authorization.authorizedByUoaSub,
      authorizedTeamId: input.authorization.authorizedTeamId,
      authorizedTokenVersion: input.authorization.authorizedTokenVersion,
      createdByUserId: input.createdByUserId,
      createdScope: 'team',
      domainId: input.domainId,
      teamId: input.teamId,
    },
    select: { id: true, teamId: true },
  })
  return { added: [created], removed: [] }
}

/**
 * Explicit recovery from `needs_reauthorization`, per
 * docs/standards/capability-health-alerts.md — never auto-healed at login,
 * because signing in proves the same person is present, not that they intend a
 * dormant automation to resume. The caller's own live identity replaces the one
 * that stopped verifying.
 */
export const reauthorizeRule = async (
  prisma: Pick<PrismaClient, 'automaticMembershipRule'>,
  input: { ruleId: string; organizationId: string; authorization: RuleAuthorization },
): Promise<{ teamId: string }> => {
  const rule = await prisma.automaticMembershipRule.findFirst({
    select: { id: true, teamId: true },
    where: { domain: { organizationId: input.organizationId }, id: input.ruleId },
  })
  if (!rule) {
    throw new AutomaticMembershipDomainError('No such rule.', 'AUTOMATIC_MEMBERSHIP_NOT_FOUND', 404)
  }
  await prisma.automaticMembershipRule.update({
    data: {
      authorizedAt: new Date(),
      authorizedByUoaSub: input.authorization.authorizedByUoaSub,
      authorizedTeamId: input.authorization.authorizedTeamId,
      authorizedTokenVersion: input.authorization.authorizedTokenVersion,
      healthReason: null,
      healthState: 'ok',
    },
    where: { id: rule.id },
  })
  return { teamId: rule.teamId }
}
