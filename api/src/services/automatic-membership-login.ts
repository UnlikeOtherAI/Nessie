import type { PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type { UoaAutomaticMembershipAdapter } from './uoa-automatic-membership.js'
import { createProductionUoaAutomaticMembershipAdapter } from './uoa-automatic-membership-production.js'

/**
 * Login-time provisioning is intentionally UOA-only: Nessie reads no profile
 * data and writes no local member row. The only durable identity is UOA's
 * subject, and the UOA service rechecks its current verified email on every
 * attestation and grant.
 */
export const provisionAutomaticMembershipAtLogin = async (
  prisma: PrismaClient,
  uoaSub: string,
): Promise<readonly { externalOrgId: string; externalTeamId: string }[]> => {
  const adapter = createProductionUoaAutomaticMembershipAdapter()
  if (!adapter || process.env.NESSIE_AUTOMATIC_MEMBERSHIP_KILL_SWITCH === 'true') return []
  return provisionAutomaticMembershipWithAdapter(prisma, uoaSub, adapter)
}

/** Injectable only for tests; production always obtains the configured UOA adapter. */
export const provisionAutomaticMembershipWithAdapter = async (
  prisma: PrismaClient,
  uoaSub: string,
  adapter: UoaAutomaticMembershipAdapter,
): Promise<readonly { externalOrgId: string; externalTeamId: string }[]> => {
  const candidates = await prisma.automaticMembershipDomainClaim.findMany({
    where: { state: 'verified', releasedAt: null, verificationExpiresAt: { gt: new Date() }, rules: { some: { state: 'active' } } },
    // A login is latency-sensitive. Bounded work is continued by the durable
    // reconciliation path; this path never scans people or emails.
    select: { id: true, domain: true }, take: 25, orderBy: { lastDnsCheckAt: 'desc' },
  })
  const targets = new Map<string, { externalOrgId: string; externalTeamId: string }>()
  for (const claim of candidates) {
    let proof: Awaited<ReturnType<typeof adapter.attestVerifiedDomain>>
    try { proof = await adapter.attestVerifiedDomain({ uoaSub, domain: claim.domain }) } catch { continue }
    if (!proof || proof.expiresAt <= new Date()) continue
    let rules: Awaited<ReturnType<typeof prisma.automaticMembershipRule.findMany>>
    try {
      rules = await prisma.automaticMembershipRule.findMany({
        where: { claimId: claim.id, state: 'active', organization: { externalOrgId: { not: null } } },
        include: {
          organization: { select: { externalOrgId: true } },
          targets: { include: { team: { select: { externalTeamId: true } } } },
        },
      })
    } catch { continue }
    for (const rule of rules.slice(0, 25)) {
      if (!rule.organization.externalOrgId) continue
      for (const target of rule.targets.slice(0, 25)) {
        if (!target.team.externalTeamId) continue
        const idempotencyKey = `automatic-membership:login:${rule.id}:${target.teamId}:${uoaSub}:${rule.generation}`
        // This persistent key makes simultaneous login events one operation.
        // Terminal outcomes are left to the durable backfill rather than adding
        // unbounded UOA retries to an interactive sign-in.
        const recorded = await prisma.automaticMembershipGrant.upsert({
          where: {
            ruleId_teamId_uoaSub_generation: {
              ruleId: rule.id, teamId: target.teamId, uoaSub, generation: rule.generation,
            },
          },
          update: {},
          create: {
            organizationId: rule.organizationId,
            ruleId: rule.id,
            teamId: target.teamId,
            uoaSub,
            generation: rule.generation,
            idempotencyKey,
          },
        })
        if (recorded.outcome === 'completed' || recorded.outcome === 'already_member') {
          targets.set(`${rule.organization.externalOrgId}:${target.team.externalTeamId}`, { externalOrgId: rule.organization.externalOrgId, externalTeamId: target.team.externalTeamId })
          continue
        }
        if (recorded.outcome === 'failed') continue
        let grant: Awaited<ReturnType<typeof adapter.grantMember>>
        try {
          grant = await adapter.grantMember({
            externalOrgId: rule.organization.externalOrgId,
            externalTeamId: target.team.externalTeamId,
            uoaSub,
            domain: claim.domain,
            idempotencyKey,
            ruleId: rule.id,
            ruleGeneration: rule.generation,
            // This is the lifecycle-installed UOA fence for this exact rule
            // generation. A worker lease is strictly local and never crosses the
            // UOA boundary, so a suspension/revoke fences login and backfill alike.
            fenceToken: rule.uoaFenceToken,
          })
        } catch { continue }
        try {
          await prisma.$transaction(async (tx) => {
            await tx.automaticMembershipGrant.update({
              where: { id: recorded.id },
              data: { operationId: grant.operationId, outcome: grant.status },
            })
            if (grant.status === 'completed' || grant.status === 'already_member') {
              await writeAuditEntryInTransaction(tx, {
                organizationId: rule.organizationId,
                teamId: target.teamId,
                actorType: 'service',
                actorId: 'automatic-membership-login',
                action: 'automatic_membership.granted',
                resourceType: 'automatic_membership_rule',
                resourceId: rule.id,
                outcome: 'success',
                metadata: { generation: rule.generation, source: 'login' },
                requestId: `automatic-membership:login:${recorded.id}`,
              })
            }
          })
        } catch { continue }
        if (grant.status === 'completed' || grant.status === 'already_member') {
          targets.set(`${rule.organization.externalOrgId}:${target.team.externalTeamId}`, { externalOrgId: rule.organization.externalOrgId, externalTeamId: target.team.externalTeamId })
        }
      }
    }
  }
  return [...targets.values()]
}
