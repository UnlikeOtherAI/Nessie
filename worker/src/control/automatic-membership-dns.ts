/* eslint-disable max-len -- the due-claim predicate is intentionally visible as one query. */
import { resolveTxt } from 'node:dns/promises'
import type { PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import { decryptAutomaticMembershipChallenge } from '@nessie/runtime'

/** Revalidation only suspends future provisioning; it cannot remove members. */
export const revalidateAutomaticMembershipDns = async (
  prisma: PrismaClient,
  authSecret: string,
  dnsLookup: (name: string) => Promise<readonly string[][]> = resolveTxt,
  limit = 20,
): Promise<void> => {
  if (process.env.NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED !== 'true' || process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_ADAPTER !== 'configured' || !authSecret) return
  const claims = await prisma.automaticMembershipDomainClaim.findMany({
    where: { state: 'verified', releasedAt: null, OR: [{ verificationExpiresAt: { lte: new Date() } }, { lastDnsCheckAt: { lte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }] },
    include: { rules: { where: { state: 'active' } } }, take: limit,
  })
  for (const claim of claims) {
    let matched = false
    try {
      const expected = decryptAutomaticMembershipChallenge(claim.challengeEncrypted, authSecret)
      const records = await dnsLookup(`_nessie-auto-access.${claim.domain}`)
      matched = records.some((record) => record.join('') === expected)
    } catch {
      // A transient resolver fault is not definitive loss. Keep the existing
      // proof until its expiry, but record the check for operations visibility.
      await prisma.automaticMembershipDomainClaim.update({ where: { id: claim.id }, data: { lastDnsCheckAt: new Date(), lastDnsFailure: 'DNS lookup was unavailable' } })
      continue
    }
    if (matched) {
      await prisma.automaticMembershipDomainClaim.update({ where: { id: claim.id }, data: { lastDnsCheckAt: new Date(), lastDnsFailure: null } })
      continue
    }
    await prisma.$transaction(async (tx) => {
      await tx.automaticMembershipDomainClaim.update({ where: { id: claim.id }, data: { state: 'suspended', lastDnsCheckAt: new Date(), lastDnsFailure: 'TXT record was missing or did not match' } })
      for (const rule of claim.rules) {
        await tx.automaticMembershipRule.update({ where: { id: rule.id }, data: { state: 'suspended', suspensionReason: 'DNS verification no longer passed.' } })
        await writeAuditEntryInTransaction(tx, { organizationId: claim.organizationId, actorType: 'service', actorId: 'automatic-membership-dns', action: 'automatic_membership.suspended', resourceType: 'automatic_membership_rule', resourceId: rule.id, outcome: 'success', requestId: `automatic-membership:dns:${claim.id}` })
      }
    })
  }
}
