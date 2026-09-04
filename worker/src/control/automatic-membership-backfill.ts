/* eslint-disable max-len -- atomic idempotency/lease queries are reviewed as single units. */
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'

/** Kept structurally identical to the API contract so tests can inject UOA. */
export type AutomaticMembershipUoaAdapter = {
  assertRuleAdministrator(input: { externalOrgId: string; externalTeamIds: readonly string[]; uoaSub: string }): Promise<boolean>
  listVerifiedDomainSubjects(input: { externalOrgId: string; domain: string; cursor?: string; snapshotId?: string; limit: number }): Promise<{ snapshotId: string; subjects: readonly string[]; cursor: string | null }>
  grantMember(input: { externalOrgId: string; externalTeamId: string; uoaSub: string; domain: string; idempotencyKey: string; ruleId: string; ruleGeneration: number; fenceToken: string }): Promise<{ operationId: string; status: 'accepted' | 'completed' | 'already_member' | 'failed' }>
  getOperation(input: { operationId: string }): Promise<{ operationId: string; status: 'accepted' | 'completed' | 'already_member' | 'failed' }>
}

export const AUTOMATIC_MEMBERSHIP_BACKFILL_TOPIC = 'automatic-membership.backfill'
const batchSize = 25
const requestsPerMinute = 60

const retryAt = (attempts: number): Date => {
  const capped = Math.min(attempts, 8)
  const jitter = Math.floor(Math.random() * 1_000)
  return new Date(Date.now() + (2 ** capped) * 1_000 + jitter)
}

/** A serializable, persisted org/domain allowance; never an in-memory throttle. */
const consumeDomainAllowance = async (prisma: PrismaClient, organizationId: string, domain: string): Promise<{ allowed: boolean; nextAttemptAt: Date }> => {
  const now = new Date()
  const nextAttemptAt = new Date(now.getTime() + 60_000)
  return prisma.$transaction(async (tx) => {
    const row = await tx.automaticMembershipRateLimit.findUnique({ where: { organizationId_domain: { organizationId, domain } } })
    if (!row || row.windowStartedAt.getTime() <= now.getTime() - 60_000) {
      await tx.automaticMembershipRateLimit.upsert({
        where: { organizationId_domain: { organizationId, domain } },
        create: { organizationId, domain, windowStartedAt: now, used: 1 },
        update: { windowStartedAt: now, used: 1 },
      })
      return { allowed: true, nextAttemptAt }
    }
    if (row.used >= requestsPerMinute) return { allowed: false, nextAttemptAt: new Date(row.windowStartedAt.getTime() + 60_000) }
    await tx.automaticMembershipRateLimit.update({ where: { organizationId_domain: { organizationId, domain } }, data: { used: { increment: 1 } } })
    return { allowed: true, nextAttemptAt }
  }, { isolationLevel: 'Serializable' })
}

const isGrantSuccess = (outcome: string): boolean => outcome === 'completed' || outcome === 'already_member'

/**
 * One bounded snapshot page. The runner never knows an email address and it
 * always re-reads rule state immediately before UOA receives a grant.
 */
export const runAutomaticMembershipBackfillBatch = async (
  prisma: PrismaClient,
  adapter: AutomaticMembershipUoaAdapter,
  runId: string,
): Promise<void> => {
  const candidate = await prisma.automaticMembershipBackfillRun.findFirst({
    where: { id: runId, status: { in: ['queued', 'running'] } },
    include: { rule: { include: { claim: true, targets: { include: { team: true } } } }, organization: { select: { externalOrgId: true } }, leases: { where: { expiresAt: { gt: new Date() } } } },
  })
  if (!candidate) return
  if (process.env.NESSIE_AUTOMATIC_MEMBERSHIP_KILL_SWITCH === 'true') {
    await prisma.automaticMembershipBackfillRun.update({ where: { id: runId }, data: { status: 'paused', lastError: 'Emergency kill switch is enabled.' } })
    return
  }
  if (candidate.rule.state !== 'active' || candidate.rule.claim.state !== 'verified' || !candidate.rule.claim.verificationExpiresAt || candidate.rule.claim.verificationExpiresAt <= new Date() || !candidate.organization.externalOrgId) {
    await prisma.automaticMembershipBackfillRun.update({ where: { id: runId }, data: { status: 'paused', lastError: 'Rule is no longer eligible for provisioning.' } })
    return
  }
  const leaseToken = randomUUID()
  const leaseUntil = new Date(Date.now() + 60_000)
  // Conditional update is the worker ownership fence. Two consumers can read
  // the candidate, but only one can install a current token for this generation.
  const claimed = await prisma.automaticMembershipBackfillRun.updateMany({
    where: { id: runId, generation: candidate.generation, status: { in: ['queued', 'running'] }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] },
    data: { status: 'running', leaseToken, leaseGeneration: candidate.generation, leaseExpiresAt: leaseUntil },
  })
  if (claimed.count !== 1) return
  try {
    const authorised = await adapter.assertRuleAdministrator({ externalOrgId: candidate.organization.externalOrgId, externalTeamIds: candidate.rule.targets.flatMap((target) => target.team.externalTeamId ? [target.team.externalTeamId] : []), uoaSub: candidate.requestedByUoaSub })
    if (!authorised) {
      await prisma.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: { status: 'paused', lastError: 'The requesting administrator no longer has permission.' } })
      return
    }
    const allowance = await consumeDomainAllowance(prisma, candidate.organizationId, candidate.rule.claim.domain)
    if (!allowance.allowed) {
      await prisma.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: { status: 'queued', nextAttemptAt: allowance.nextAttemptAt, lastError: 'Domain backfill rate limit reached.' } })
      return
    }
    const page = await adapter.listVerifiedDomainSubjects({
      externalOrgId: candidate.organization.externalOrgId, domain: candidate.rule.claim.domain,
      ...(candidate.cursor ? { cursor: candidate.cursor } : {}), ...(candidate.snapshotId ? { snapshotId: candidate.snapshotId } : {}), limit: batchSize,
    })
    for (const uoaSub of page.subjects) {
      // Configuration can change while the snapshot page is in flight. Refuse
      // stale generations/targets before every individual external operation.
      const fresh = await prisma.automaticMembershipBackfillRun.findFirst({
        where: { id: runId, generation: candidate.generation, leaseToken, leaseGeneration: candidate.generation, leaseExpiresAt: { gt: new Date() }, status: 'running', rule: { state: 'active', claim: { state: 'verified', verificationExpiresAt: { gt: new Date() } } } },
        include: { rule: { include: { claim: true, targets: { include: { team: true } } } }, organization: { select: { externalOrgId: true } } },
      })
      if (!fresh || process.env.NESSIE_AUTOMATIC_MEMBERSHIP_KILL_SWITCH === 'true') break
      const seenSubject = await prisma.automaticMembershipGrant.findFirst({ where: { ruleId: fresh.rule.id, generation: fresh.generation, uoaSub }, select: { id: true } })
      for (const target of fresh.rule.targets) {
        if (!target.team.externalTeamId || !fresh.organization.externalOrgId) continue
        const idempotencyKey = `automatic-membership:${fresh.rule.id}:${target.teamId}:${uoaSub}:${fresh.generation}`
        const grant = await prisma.automaticMembershipGrant.upsert({
          where: { ruleId_teamId_uoaSub_generation: { ruleId: fresh.rule.id, teamId: target.teamId, uoaSub, generation: fresh.generation } },
          update: {}, create: { organizationId: fresh.organizationId, ruleId: fresh.rule.id, teamId: target.teamId, uoaSub, generation: fresh.generation, idempotencyKey },
        })
        if (grant.outcome === 'completed' || grant.outcome === 'already_member') continue
        if (grant.operationId) {
          const operation = await adapter.getOperation({ operationId: grant.operationId })
          if (operation.status === 'accepted') continue
          await prisma.$transaction(async (tx) => {
            const changed = await tx.automaticMembershipGrant.updateMany({ where: { id: grant.id, outcome: 'pending' }, data: { outcome: operation.status } })
            if (changed.count !== 1) return
            if (isGrantSuccess(operation.status)) await tx.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: { grantedCount: { increment: 1 } } })
            else await tx.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: { failureCount: { increment: 1 } } })
            await writeAuditEntryInTransaction(tx, { organizationId: fresh.organizationId, teamId: target.teamId, actorType: 'service', actorId: 'automatic-membership-backfill', action: isGrantSuccess(operation.status) ? 'automatic_membership.granted' : 'automatic_membership.grant_failed', resourceType: 'automatic_membership_rule', resourceId: fresh.rule.id, outcome: isGrantSuccess(operation.status) ? 'success' : 'error', metadata: { generation: fresh.generation }, requestId: `automatic-membership:${runId}` })
          })
          continue
        }
        const operation = await adapter.grantMember({ externalOrgId: fresh.organization.externalOrgId, externalTeamId: target.team.externalTeamId, uoaSub, domain: fresh.rule.claim.domain, idempotencyKey, ruleId: fresh.rule.id, ruleGeneration: fresh.generation, fenceToken: fresh.rule.uoaFenceToken })
        await prisma.$transaction(async (tx) => {
          const outcome = operation.status === 'accepted' ? 'pending' : operation.status
          const changed = await tx.automaticMembershipGrant.updateMany({ where: { id: grant.id, outcome: 'pending' }, data: { operationId: operation.operationId, outcome } })
          if (changed.count !== 1 || outcome === 'pending') return
          if (isGrantSuccess(outcome)) await tx.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: { grantedCount: { increment: 1 } } })
          else await tx.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: { failureCount: { increment: 1 } } })
          await writeAuditEntryInTransaction(tx, { organizationId: fresh.organizationId, teamId: target.teamId, actorType: 'service', actorId: 'automatic-membership-backfill', action: isGrantSuccess(outcome) ? 'automatic_membership.granted' : 'automatic_membership.grant_failed', resourceType: 'automatic_membership_rule', resourceId: fresh.rule.id, outcome: isGrantSuccess(outcome) ? 'success' : 'error', metadata: { generation: fresh.generation }, requestId: `automatic-membership:${runId}` })
        })
      }
      if (!seenSubject) await prisma.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: { attemptedCount: { increment: 1 } } })
    }
    const pendingGrants = await prisma.automaticMembershipGrant.count({ where: { ruleId: candidate.ruleId, generation: candidate.generation, outcome: 'pending' } })
    await prisma.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: {
      // A returned cursor means the next bounded page is due. Pending upstream
      // grants retain a queued run too, so operation status is reconciled after
      // an accepted asynchronous grant instead of being guessed complete.
      status: page.cursor || pendingGrants > 0 ? 'queued' : 'completed', cursor: page.cursor, snapshotId: page.snapshotId,
      ...(page.cursor || pendingGrants > 0 ? { nextAttemptAt: new Date(Date.now() + 2_000) } : {}),
    } })
  } catch (error) {
    const current = await prisma.automaticMembershipBackfillRun.findUnique({ where: { id: runId }, select: { failureCount: true } })
    const failures = (current?.failureCount ?? 0) + 1
    await prisma.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: { status: failures >= 8 ? 'completed_with_failures' : 'queued', failureCount: { increment: 1 }, attemptCount: { increment: 1 }, lastError: error instanceof Error ? error.message.slice(0, 500) : 'Unknown UOA backfill failure', ...(failures >= 8 ? {} : { nextAttemptAt: retryAt(failures) }) } })
  } finally {
    await prisma.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: { leaseToken: null, leaseGeneration: null, leaseExpiresAt: null } })
  }
}

/** Pick due work without ever starting a local-authority fallback. */
export const sweepAutomaticMembershipBackfills = async (prisma: PrismaClient, adapter: AutomaticMembershipUoaAdapter, limit = 5): Promise<void> => {
  if (process.env.NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED !== 'true') return
  const due = await prisma.automaticMembershipBackfillRun.findMany({ where: { status: { in: ['queued', 'running'] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] }, select: { id: true }, take: limit, orderBy: { createdAt: 'asc' } })
  for (const run of due) await runAutomaticMembershipBackfillBatch(prisma, adapter, run.id)
}
