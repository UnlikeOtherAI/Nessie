/* eslint-disable max-len -- atomic idempotency/lease queries are reviewed as single units. */
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'

/** Kept structurally identical to the API contract so tests can inject UOA. */
export type AutomaticMembershipUoaAdapter = {
  assertRuleAdministrator(input: { externalOrgId: string; externalTeamIds: readonly string[]; uoaSub: string }): Promise<boolean>
  setRuleFence(input: { externalOrgId: string; ruleId: string; generation: number; fenceToken: string; active: boolean }): Promise<void>
  listVerifiedDomainSubjects(input: { externalOrgId: string; domain: string; cursor?: string; snapshotId?: string; limit: number }): Promise<{ snapshotId: string; subjects: readonly string[]; cursor: string | null }>
  grantMember(input: { externalOrgId: string; externalTeamId: string; uoaSub: string; idempotencyKey: string; ruleId: string; ruleGeneration: number; fenceToken: string }): Promise<{ operationId: string; status: 'accepted' | 'completed' | 'already_member' | 'failed' }>
  getOperation(input: { operationId: string }): Promise<{ operationId: string; status: 'accepted' | 'completed' | 'already_member' | 'failed' }>
}

export const AUTOMATIC_MEMBERSHIP_BACKFILL_TOPIC = 'automatic-membership.backfill'
const batchSize = 25

const retryAt = (attempts: number): Date => {
  const capped = Math.min(attempts, 8)
  const jitter = Math.floor(Math.random() * 1_000)
  return new Date(Date.now() + (2 ** capped) * 1_000 + jitter)
}

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
    await adapter.setRuleFence({ externalOrgId: candidate.organization.externalOrgId, ruleId: candidate.ruleId, generation: candidate.generation, fenceToken: leaseToken, active: true })
    const page = await adapter.listVerifiedDomainSubjects({
      externalOrgId: candidate.organization.externalOrgId, domain: candidate.rule.claim.domain,
      ...(candidate.cursor ? { cursor: candidate.cursor } : {}), ...(candidate.snapshotId ? { snapshotId: candidate.snapshotId } : {}), limit: batchSize,
    })
    for (const uoaSub of page.subjects) {
      // Configuration can change while the snapshot page is in flight. Refuse
      // stale generations/targets before every individual external operation.
      const fresh = await prisma.automaticMembershipBackfillRun.findFirst({
        where: { id: runId, generation: candidate.generation, leaseToken, leaseGeneration: candidate.generation, leaseExpiresAt: { gt: new Date() }, status: 'running', rule: { state: 'active', claim: { state: 'verified', verificationExpiresAt: { gt: new Date() } } } },
        include: { rule: { include: { targets: { include: { team: true } } } }, organization: { select: { externalOrgId: true } } },
      })
      if (!fresh || process.env.NESSIE_AUTOMATIC_MEMBERSHIP_KILL_SWITCH === 'true') break
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
          await prisma.automaticMembershipGrant.update({ where: { id: grant.id }, data: { outcome: operation.status } })
          continue
        }
        const operation = await adapter.grantMember({ externalOrgId: fresh.organization.externalOrgId, externalTeamId: target.team.externalTeamId, uoaSub, idempotencyKey, ruleId: fresh.rule.id, ruleGeneration: fresh.generation, fenceToken: leaseToken })
        await prisma.$transaction(async (tx) => {
          await tx.automaticMembershipGrant.update({ where: { id: grant.id }, data: { operationId: operation.operationId, outcome: operation.status === 'accepted' ? 'pending' : operation.status } })
          if (operation.status === 'completed' || operation.status === 'already_member') {
            await writeAuditEntryInTransaction(tx, { organizationId: fresh.organizationId, teamId: target.teamId, actorType: 'service', actorId: 'automatic-membership-backfill', action: 'automatic_membership.granted', resourceType: 'automatic_membership_rule', resourceId: fresh.rule.id, outcome: 'success', metadata: { generation: fresh.generation }, requestId: `automatic-membership:${runId}` })
          }
        })
      }
    }
    const pendingGrants = await prisma.automaticMembershipGrant.count({ where: { ruleId: candidate.ruleId, generation: candidate.generation, outcome: 'pending' } })
    await prisma.automaticMembershipBackfillRun.updateMany({ where: { id: runId, leaseToken }, data: {
      // A returned cursor means the next bounded page is due. Pending upstream
      // grants retain a queued run too, so operation status is reconciled after
      // an accepted asynchronous grant instead of being guessed complete.
      status: page.cursor || pendingGrants > 0 ? 'queued' : 'completed', cursor: page.cursor, snapshotId: page.snapshotId,
      attemptedCount: { increment: page.subjects.length }, ...(page.cursor || pendingGrants > 0 ? { nextAttemptAt: new Date(Date.now() + 2_000) } : {}),
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
