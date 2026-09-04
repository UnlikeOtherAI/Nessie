import type { PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type { UoaAutomaticMembershipAdapter } from '@nessie/team-admin'
import { createProductionUoaAutomaticMembershipAdapter } from './uoa-automatic-membership-production.js'

const loginRuleLimit = 12
const loginGrantLimit = 24

type AutomaticTarget = { externalOrgId: string; externalTeamId: string }

/**
 * Login-time provisioning reads only UOA's current attestation and writes no
 * local user profile or membership. It is deliberately bounded: the durable
 * backfill owns exhaustive reconciliation, while a slow UOA must not deny an
 * otherwise valid sign-in.
 */
export const provisionAutomaticMembershipAtLogin = async (
  prisma: PrismaClient,
  uoaSub: string,
): Promise<readonly AutomaticTarget[]> => {
  const adapter = createProductionUoaAutomaticMembershipAdapter()
  if (!adapter || process.env.NESSIE_AUTOMATIC_MEMBERSHIP_KILL_SWITCH === 'true') return []
  return provisionAutomaticMembershipWithAdapter(prisma, uoaSub, adapter)
}

/** Injectable only for focused tests; production always constructs the UOA adapter. */
export const provisionAutomaticMembershipWithAdapter = async (
  prisma: PrismaClient,
  uoaSub: string,
  adapter: UoaAutomaticMembershipAdapter,
): Promise<readonly AutomaticTarget[]> => {
  const rules = await prisma.automaticMembershipRule.findMany({
    where: {
      state: 'active',
      claim: { state: 'verified', releasedAt: null, verificationExpiresAt: { gt: new Date() } },
      organization: { externalOrgId: { not: null } },
    },
    include: {
      claim: { select: { domain: true } },
      organization: { select: { externalOrgId: true } },
      targets: { include: { team: { select: { externalTeamId: true } } } },
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: loginRuleLimit,
  })
  const verified = new Map<string, boolean>()
  const targets = new Map<string, AutomaticTarget>()
  let grants = 0

  for (const rule of rules) {
    if (!rule.organization.externalOrgId) continue
    const attestationKey = `${rule.organization.externalOrgId}:${rule.claim.domain}`
    let isVerified = verified.get(attestationKey)
    if (isVerified === undefined) {
      try {
        const proof = await adapter.attestVerifiedDomain({
          externalOrgId: rule.organization.externalOrgId,
          uoaSub,
          domain: rule.claim.domain,
        })
        isVerified = Boolean(proof && proof.expiresAt > new Date())
      } catch {
        isVerified = false
      }
      verified.set(attestationKey, isVerified)
    }
    if (!isVerified) continue

    for (const target of rule.targets) {
      if (grants >= loginGrantLimit) return [...targets.values()]
      if (!target.team.externalTeamId) continue
      grants += 1
      const idempotencyKey = `automatic-membership:login:${rule.id}:${target.teamId}:${uoaSub}:${rule.generation}`
      let recorded: { id: string; outcome: string }
      try {
        recorded = await prisma.automaticMembershipGrant.upsert({
          where: { ruleId_teamId_uoaSub_generation: { ruleId: rule.id, teamId: target.teamId, uoaSub, generation: rule.generation } },
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
      } catch {
        continue
      }
      if (recorded.outcome === 'completed' || recorded.outcome === 'already_member') {
        targets.set(`${rule.organization.externalOrgId}:${target.team.externalTeamId}`, {
          externalOrgId: rule.organization.externalOrgId,
          externalTeamId: target.team.externalTeamId,
        })
        continue
      }
      if (recorded.outcome !== 'pending') continue

      try {
        const grant = await adapter.grantMember({
          externalOrgId: rule.organization.externalOrgId,
          externalTeamId: target.team.externalTeamId,
          uoaSub,
          domain: rule.claim.domain,
          idempotencyKey,
          ruleId: rule.id,
          ruleGeneration: rule.generation,
          lifecycleRevision: rule.generation,
          fenceToken: rule.uoaFenceToken,
        })
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
        if (grant.status === 'completed' || grant.status === 'already_member') {
          targets.set(`${rule.organization.externalOrgId}:${target.team.externalTeamId}`, {
            externalOrgId: rule.organization.externalOrgId,
            externalTeamId: target.team.externalTeamId,
          })
        }
      } catch {
        // A valid sign-in never waits for or fails on automatic provisioning.
      }
    }
  }
  return [...targets.values()]
}
