/**
 * The panel's read model. One response shape serves both the organisation and
 * the team surface so the admin renders one component parameterised by scope.
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §12.
 */

import type { PrismaClient } from '@prisma/client'
import {
  domainVerificationRecordName,
  domainVerificationRecordValue,
  type AutomaticMembershipDomainRecord,
  type AutomaticMembershipPermissions,
  type AutomaticMembershipReconcileStatus,
  type AutomaticMembershipResponse,
  type AutomaticMembershipRuleRecord,
  type AutomaticMembershipTeamOption,
} from '@nessie/schemas'

export type ReadModelPrisma = Pick<
  PrismaClient,
  'automaticMembershipDomain' | 'automaticMembershipReconciliation' | 'team'
>

export type ReadModelScope =
  | { kind: 'organization' }
  /** The team surface sees only its own team's rules. */
  | { kind: 'team'; teamId: string }

const iso = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

/**
 * Teams this organisation may point a domain at. `systemManaged` teams — the
 * Personal Assistant and external-agent surfaces — are not places a person is
 * put, so they are never offered.
 */
export const listTeamOptions = async (
  prisma: Pick<PrismaClient, 'team'>,
  organizationId: string,
): Promise<AutomaticMembershipTeamOption[]> => {
  const teams = await prisma.team.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
    where: {
      externalTeamId: { not: null },
      project: { organizationId },
      systemManaged: false,
    },
  })
  return teams.map((team) => ({ id: team.id, name: team.name }))
}

/**
 * Build the response.
 *
 * `includeChallenge` is false for every reader who is not an organisation
 * administrator of the owning organisation. The challenge is the proof of
 * domain control, so it is stripped server-side rather than merely hidden by
 * the client — the team surface receives the same shape without it.
 */
export const buildAutomaticMembershipResponse = async (
  prisma: ReadModelPrisma,
  input: {
    organizationId: string
    scope: ReadModelScope
    permissions: AutomaticMembershipPermissions
    provisioningEnabled: boolean
    includeChallenge: boolean
    manageableTeamIds: ReadonlySet<string> | 'all'
  },
): Promise<AutomaticMembershipResponse> => {
  const domains = await prisma.automaticMembershipDomain.findMany({
    orderBy: { createdAt: 'asc' },
    where: {
      organizationId: input.organizationId,
      status: { not: 'revoked' },
      // A team only ever sees domains that already grant it, so the team
      // surface cannot be used to enumerate the organisation's whole domain
      // inventory.
      ...(input.scope.kind === 'team'
        ? { rules: { some: { teamId: input.scope.teamId } } }
        : {}),
    },
    select: {
      challenge: true,
      challengeExpiresAt: true,
      domain: true,
      firstSeenAt: true,
      id: true,
      lastCheckDetail: true,
      lastCheckOutcome: true,
      lastCheckedAt: true,
      status: true,
      verifiedAt: true,
      rules: {
        orderBy: { createdAt: 'asc' },
        where: input.scope.kind === 'team' ? { teamId: input.scope.teamId } : {},
        select: {
          createdScope: true,
          enabled: true,
          healthReason: true,
          healthState: true,
          id: true,
          team: { select: { id: true, name: true } },
          _count: { select: { grants: true } },
        },
      },
    },
  })

  const latestRuns = await prisma.automaticMembershipReconciliation.findMany({
    distinct: ['domainId'],
    orderBy: [{ domainId: 'asc' }, { createdAt: 'desc' }],
    where: { domainId: { in: domains.map((domain) => domain.id) } },
    select: {
      domainId: true,
      failed: true,
      finishedAt: true,
      granted: true,
      id: true,
      lastError: true,
      matched: true,
      scanned: true,
      skipped: true,
      startedAt: true,
      status: true,
    },
  })
  const runByDomain = new Map(latestRuns.map((run) => [run.domainId, run]))

  const records: AutomaticMembershipDomainRecord[] = domains.map((domain) => {
    const run = runByDomain.get(domain.id)
    const rules: AutomaticMembershipRuleRecord[] = domain.rules.map((rule) => ({
      createdScope: rule.createdScope === 'team' ? 'team' : 'organization',
      enabled: rule.enabled,
      grantedCount: rule._count.grants,
      health: rule.healthState === 'needs_reauthorization' ? 'needs_reauthorization' : 'ok',
      ...(rule.healthReason ? { healthReason: rule.healthReason } : {}),
      id: rule.id,
      manageable:
        input.manageableTeamIds === 'all' || input.manageableTeamIds.has(rule.team.id),
      teamId: rule.team.id,
      teamName: rule.team.name,
    }))

    return {
      challengeExpiresAt: domain.challengeExpiresAt.toISOString(),
      domain: domain.domain,
      id: domain.id,
      recordName: domainVerificationRecordName(domain.domain),
      rules,
      status: domain.status,
      ...(input.includeChallenge
        ? {
          challenge: domain.challenge,
          recordValue: domainVerificationRecordValue(domain.challenge),
        }
        : {}),
      ...(iso(domain.firstSeenAt) ? { firstSeenAt: iso(domain.firstSeenAt) } : {}),
      ...(iso(domain.verifiedAt) ? { verifiedAt: iso(domain.verifiedAt) } : {}),
      ...(iso(domain.lastCheckedAt) ? { lastCheckedAt: iso(domain.lastCheckedAt) } : {}),
      ...(domain.lastCheckOutcome ? { lastCheckOutcome: domain.lastCheckOutcome } : {}),
      ...(domain.lastCheckDetail ? { lastCheckDetail: domain.lastCheckDetail } : {}),
      ...(run
        ? {
          reconciliation: {
            failed: run.failed,
            granted: run.granted,
            id: run.id,
            matched: run.matched,
            scanned: run.scanned,
            skipped: run.skipped,
            status: run.status as AutomaticMembershipReconcileStatus,
            ...(run.lastError ? { lastError: run.lastError } : {}),
            ...(iso(run.startedAt) ? { startedAt: iso(run.startedAt) } : {}),
            ...(iso(run.finishedAt) ? { finishedAt: iso(run.finishedAt) } : {}),
          },
        }
        : {}),
    }
  })

  return {
    domains: records,
    permissions: input.permissions,
    provisioningEnabled: input.provisioningEnabled,
    teamOptions:
      input.scope.kind === 'organization'
        ? await listTeamOptions(prisma, input.organizationId)
        : [],
  }
}
