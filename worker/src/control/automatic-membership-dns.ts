/* eslint-disable max-len -- the due-claim predicate is intentionally visible as one query. */
import { resolveTxt } from 'node:dns/promises'
import type { PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import { decryptAutomaticMembershipChallenge } from '@nessie/runtime'
import { assertAutomaticMembershipDomainAllowed, type UoaAutomaticMembershipAdapter } from '@nessie/team-admin'
import { randomUUID } from 'node:crypto'

type UoaFenceAdapter = Pick<UoaAutomaticMembershipAdapter, 'setRuleFence'>

const deactivate = async (prisma: PrismaClient, adapter: UoaFenceAdapter, rule: { id: string; generation: number }, externalOrgId: string, reason: string): Promise<void> => {
  const generation = rule.generation + 1
  const token = randomUUID()
  await adapter.setRuleFence({ externalOrgId, ruleId: rule.id, generation, lifecycleRevision: generation, fenceToken: token, active: false })
  const changed = await prisma.automaticMembershipRule.updateMany({ where: { id: rule.id, generation: rule.generation, state: 'active' }, data: { state: 'suspended', generation, uoaFenceToken: token, suspensionReason: reason } })
  if (changed.count !== 1) throw new Error('Automatic membership rule changed while DNS suspension was applied')
}

export const suspendAutomaticMembershipForKillSwitch = async (prisma: PrismaClient, adapter: UoaFenceAdapter): Promise<void> => {
  const rules = await prisma.automaticMembershipRule.findMany({ where: { state: 'active' }, include: { organization: { select: { externalOrgId: true } } }, take: 100 })
  for (const rule of rules) {
    if (!rule.organization.externalOrgId) continue
    await deactivate(prisma, adapter, rule, rule.organization.externalOrgId, 'Emergency kill switch is enabled.')
    await prisma.$transaction((tx) => writeAuditEntryInTransaction(tx, { organizationId: rule.organizationId, actorType: 'service', actorId: 'automatic-membership-kill-switch', action: 'automatic_membership.suspended', resourceType: 'automatic_membership_rule', resourceId: rule.id, outcome: 'success', metadata: { reason: 'kill_switch' }, requestId: `automatic-membership:kill-switch:${rule.id}` }))
  }
}

/** Revalidation only suspends future provisioning; it cannot remove members. */
export const revalidateAutomaticMembershipDns = async (
  prisma: PrismaClient,
  authSecret: string,
  adapter: UoaFenceAdapter,
  dnsLookup: (name: string) => Promise<readonly string[][]> = resolveTxt,
  limit = 20,
): Promise<void> => {
  // DNS health is independent from the provisioning flag/kill switch. A
  // disabled worker never grants access, but it must still record expired proof
  // and suspend active rules rather than leaving a stale verified state.
  if (!authSecret) return
  const claims = await prisma.automaticMembershipDomainClaim.findMany({
    where: { state: 'verified', releasedAt: null, OR: [{ verificationExpiresAt: { lte: new Date() } }, { lastDnsCheckAt: null }, { lastDnsCheckAt: { lte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }] },
    include: { organization: { select: { externalOrgId: true } }, rules: { where: { state: 'active' } } }, take: limit,
  })
  for (const claim of claims) {
    try { assertAutomaticMembershipDomainAllowed(claim.domain) } catch (error) {
      if (claim.organization.externalOrgId) for (const rule of claim.rules) await deactivate(prisma, adapter, rule, claim.organization.externalOrgId, 'The current domain policy no longer permits this domain.')
      await prisma.$transaction(async (tx) => {
        await tx.automaticMembershipDomainClaim.update({ where: { id: claim.id }, data: { state: 'suspended', lastDnsCheckAt: new Date(), lastDnsFailure: 'The current domain classifier no longer permits this domain' } })
        await writeAuditEntryInTransaction(tx, { organizationId: claim.organizationId, actorType: 'service', actorId: 'automatic-membership-dns', action: 'automatic_membership.dns_checked', resourceType: 'automatic_membership_claim', resourceId: claim.id, outcome: 'error', metadata: { matched: false, reclassified: true, reason: error instanceof Error ? error.message : 'domain_policy' }, requestId: `automatic-membership:dns:${claim.id}` })
      })
      continue
    }
    let matched = false
    try {
      const expected = decryptAutomaticMembershipChallenge(claim.challengeEncrypted, authSecret)
      const records = await dnsLookup(`_nessie-auto-access.${claim.domain}`)
      matched = records.some((record) => record.join('') === expected)
    } catch {
      // A transient resolver fault is not definitive loss. Keep the existing
      // proof until its expiry, but record the check for operations visibility.
      if (claim.verificationExpiresAt && claim.verificationExpiresAt <= new Date()) {
        if (!claim.organization.externalOrgId) continue
        for (const rule of claim.rules) await deactivate(prisma, adapter, rule, claim.organization.externalOrgId, 'DNS verification expired and could not be revalidated.')
        await prisma.$transaction(async (tx) => {
          await tx.automaticMembershipDomainClaim.update({ where: { id: claim.id }, data: { state: 'suspended', lastDnsCheckAt: new Date(), lastDnsFailure: 'DNS lookup was unavailable after verification expired' } })
          await writeAuditEntryInTransaction(tx, { organizationId: claim.organizationId, actorType: 'service', actorId: 'automatic-membership-dns', action: 'automatic_membership.suspended', resourceType: 'automatic_membership_claim', resourceId: claim.id, outcome: 'error', metadata: { reason: 'dns_unavailable_after_expiry' }, requestId: `automatic-membership:dns:${claim.id}` })
          await writeAuditEntryInTransaction(tx, { organizationId: claim.organizationId, actorType: 'service', actorId: 'automatic-membership-dns', action: 'automatic_membership.dns_checked', resourceType: 'automatic_membership_claim', resourceId: claim.id, outcome: 'error', metadata: { matched: false, reason: 'dns_unavailable_after_expiry' }, requestId: `automatic-membership:dns:${claim.id}` })
        })
      } else {
        await prisma.automaticMembershipDomainClaim.update({ where: { id: claim.id }, data: { lastDnsCheckAt: new Date(), lastDnsFailure: 'DNS lookup was unavailable' } })
      }
      continue
    }
    if (matched) {
      const checkedAt = new Date()
      await prisma.$transaction(async (tx) => {
        await tx.automaticMembershipDomainClaim.update({ where: { id: claim.id }, data: { lastDnsCheckAt: checkedAt, verificationExpiresAt: new Date(checkedAt.getTime() + 14 * 24 * 60 * 60 * 1000), lastDnsFailure: null } })
        await writeAuditEntryInTransaction(tx, { organizationId: claim.organizationId, actorType: 'service', actorId: 'automatic-membership-dns', action: 'automatic_membership.dns_checked', resourceType: 'automatic_membership_claim', resourceId: claim.id, outcome: 'success', metadata: { matched: true }, requestId: `automatic-membership:dns:${claim.id}` })
      })
      continue
    }
    if (!claim.organization.externalOrgId) continue
    for (const rule of claim.rules) await deactivate(prisma, adapter, rule, claim.organization.externalOrgId, 'DNS verification no longer passed.')
    await prisma.$transaction(async (tx) => {
      await tx.automaticMembershipDomainClaim.update({ where: { id: claim.id }, data: { state: 'suspended', lastDnsCheckAt: new Date(), lastDnsFailure: 'TXT record was missing or did not match' } })
      for (const rule of claim.rules) {
        await writeAuditEntryInTransaction(tx, { organizationId: claim.organizationId, actorType: 'service', actorId: 'automatic-membership-dns', action: 'automatic_membership.suspended', resourceType: 'automatic_membership_rule', resourceId: rule.id, outcome: 'success', requestId: `automatic-membership:dns:${claim.id}` })
      }
      await writeAuditEntryInTransaction(tx, { organizationId: claim.organizationId, actorType: 'service', actorId: 'automatic-membership-dns', action: 'automatic_membership.dns_checked', resourceType: 'automatic_membership_claim', resourceId: claim.id, outcome: 'error', metadata: { matched: false }, requestId: `automatic-membership:dns:${claim.id}` })
    })
  }
}
