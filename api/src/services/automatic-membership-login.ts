import type { PrismaClient } from '@prisma/client'
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
  const candidates = await prisma.automaticMembershipDomainClaim.findMany({
    where: { state: 'verified', releasedAt: null, verificationExpiresAt: { gt: new Date() }, rules: { some: { state: 'active' } } },
    select: { id: true, domain: true }, take: 100,
  })
  const targets = new Map<string, { externalOrgId: string; externalTeamId: string }>()
  for (const claim of candidates) {
    const proof = await adapter.attestVerifiedDomain({ uoaSub, domain: claim.domain })
    if (!proof || proof.expiresAt <= new Date()) continue
    const rules = await prisma.automaticMembershipRule.findMany({
      where: { claimId: claim.id, state: 'active', organization: { externalOrgId: { not: null } } },
      include: { organization: { select: { externalOrgId: true } }, targets: { include: { team: { select: { externalTeamId: true } } } } },
    })
    for (const rule of rules) {
      if (!rule.organization.externalOrgId) continue
      for (const target of rule.targets) {
        if (!target.team.externalTeamId) continue
        const grant = await adapter.grantMember({
          externalOrgId: rule.organization.externalOrgId,
          externalTeamId: target.team.externalTeamId,
          uoaSub,
          idempotencyKey: `automatic-membership:login:${rule.id}:${target.teamId}:${uoaSub}:${rule.generation}`,
          ruleId: rule.id,
          ruleGeneration: rule.generation,
          // UOA validates the rule-generation fence against Nessie's callback;
          // this one-time login fence cannot be replayed as a background lease.
          fenceToken: `login:${rule.id}:${rule.generation}`,
        })
        if (grant.status === 'completed' || grant.status === 'already_member') targets.set(`${rule.organization.externalOrgId}:${target.team.externalTeamId}`, { externalOrgId: rule.organization.externalOrgId, externalTeamId: target.team.externalTeamId })
      }
    }
  }
  return [...targets.values()]
}
