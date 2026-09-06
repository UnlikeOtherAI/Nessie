import type { PrismaClient } from '@prisma/client'

import { acquireAdmissionLock, type AdmissionPrismaClient } from './admission-lock.js'
import type { BudgetScope, BudgetScopeType } from './budget.js'
import { currentStorageUsageBytes } from './ledger.js'

// A per-scope hard cap on bytes AT REST (Budget.storageLimitBytes). Resolved
// most-specific-first like the spend budget, but independent of BudgetMode: any
// scope with a limit set governs, and exceeding it blocks new uploads.
//
// ADMISSION GUARANTEE. `withStorageAdmission` runs the quota check and the
// `storage_usage_events` write in ONE transaction, behind
// `pg_advisory_xact_lock` on the uploading organisation. So: N concurrent
// uploads that each fit alone but not together admit exactly as many as fit —
// the loser reads the winner's usage event, because that event is already
// committed when the lock is handed over. The quota is exact, with no "modulo
// concurrent uploads" caveat. What it does NOT cover is bytes written outside
// `FileService`; that is the chokepoint rule stated in `./files/index.ts`, and
// this guarantee rests on it.
//
// The lock is taken on the ORGANISATION rather than on the governing limit's
// own scope. The limit resolves most-specific-first, so two uploads that
// genuinely contend can resolve to different scopes (a team limit and the
// parent organisation limit that also counts those bytes); only their common
// ancestor is a name they both compute, and it is known before any read.

export type StorageQuotaDecision =
  | { allowed: true; usedBytes: bigint; limitBytes: bigint | null }
  | { allowed: false; usedBytes: bigint; limitBytes: bigint; reason: string }

export type StorageQuotaDenial = Extract<StorageQuotaDecision, { allowed: false }>

const resolveStorageLimit = async (
  prisma: AdmissionPrismaClient,
  scope: BudgetScope,
): Promise<{ scopeType: BudgetScopeType; scopeId: string; limitBytes: bigint } | null> => {
  const candidates: Array<{ scopeType: BudgetScopeType; scopeId: string }> = []
  if (scope.teamId) candidates.push({ scopeType: 'team', scopeId: scope.teamId })
  if (scope.projectId) candidates.push({ scopeType: 'project', scopeId: scope.projectId })
  candidates.push({ scopeType: 'organization', scopeId: scope.organizationId })

  const rows = await prisma.budget.findMany({
    where: { OR: candidates.map((c) => ({ scopeType: c.scopeType, scopeId: c.scopeId })) },
    select: { scopeType: true, scopeId: true, storageLimitBytes: true },
  })

  for (const candidate of candidates) {
    const row = rows.find(
      (r) => r.scopeType === candidate.scopeType && r.scopeId === candidate.scopeId,
    )
    if (row && row.storageLimitBytes !== null) {
      return { scopeType: candidate.scopeType, scopeId: candidate.scopeId, limitBytes: row.storageLimitBytes }
    }
  }
  return null
}

// Measure usage at the SAME scope the governing limit applies to, so the
// comparison is apples-to-apples.
const usageScopeForLimit = (
  limit: { scopeType: BudgetScopeType; scopeId: string },
  organizationId: string,
): { organizationId: string; projectId?: string; teamId?: string } => {
  if (limit.scopeType === 'team') return { organizationId, teamId: limit.scopeId }
  if (limit.scopeType === 'project') return { organizationId, projectId: limit.scopeId }
  return { organizationId }
}

export const checkStorageQuota = async (
  prisma: AdmissionPrismaClient,
  scope: BudgetScope,
  addBytes: number | bigint,
): Promise<StorageQuotaDecision> => {
  const limit = await resolveStorageLimit(prisma, scope)
  if (!limit) {
    const usedBytes = await currentStorageUsageBytes(prisma, {
      organizationId: scope.organizationId,
    })
    return { allowed: true, usedBytes, limitBytes: null }
  }

  const usedBytes = await currentStorageUsageBytes(
    prisma,
    usageScopeForLimit(limit, scope.organizationId),
  )
  const add = typeof addBytes === 'bigint' ? addBytes : BigInt(Math.max(0, Math.trunc(addBytes)))
  if (usedBytes + add > limit.limitBytes) {
    return {
      allowed: false,
      usedBytes,
      limitBytes: limit.limitBytes,
      reason:
        `Storage quota exceeded: ${(usedBytes + add).toString()} bytes would exceed the `
        + `${limit.limitBytes.toString()}-byte ${limit.scopeType} limit`,
    }
  }
  return { allowed: true, usedBytes, limitBytes: limit.limitBytes }
}

export type StorageAdmission<T> =
  | { admitted: true; value: T }
  | { admitted: false; decision: StorageQuotaDenial }

/**
 * Check the quota and record the bytes as one indivisible step.
 *
 * `store` runs inside the same transaction as the check, under the
 * organisation's admission lock, and MUST be where the `storage_usage_events`
 * rows are written — that is what a concurrent uploader reads. Everything slow
 * belongs outside: the object bytes are already in the blob store by the time
 * this is called, so the critical section is one aggregate plus a few inserts.
 *
 * A denial returns rather than throws, so the caller can clean up the objects it
 * already wrote and raise its own error with its own copy.
 */
export const withStorageAdmission = async <T>(
  prisma: PrismaClient,
  scope: BudgetScope,
  addBytes: number | bigint,
  store: (tx: AdmissionPrismaClient) => Promise<T>,
): Promise<StorageAdmission<T>> =>
  prisma.$transaction(async (tx) => {
    await acquireAdmissionLock(tx, `storage:organization:${scope.organizationId}`)
    const decision = await checkStorageQuota(tx, scope, addBytes)
    if (!decision.allowed) {
      return { admitted: false, decision }
    }
    return { admitted: true, value: await store(tx) }
  })
