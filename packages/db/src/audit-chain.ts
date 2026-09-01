import { createHash } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'

// Tamper-evident audit trail: every AuditLog row is linked into a per-organization
// SHA-256 hash chain. Each entry stores `entryHash = sha256(canonicalJson(fields,
// prevHash))`, where `prevHash` is the previous chained entry's `entryHash` for
// the same organization (null for the first / genesis entry). Rewriting or
// deleting any historical entry breaks every hash after it, and the verify walk
// detects the first break.
//
// Per-org chains keep tenants isolated and avoid a single global write
// bottleneck. Writes for one organization are serialized with a
// transaction-scoped PostgreSQL advisory lock so the "read tip → hash → insert"
// step cannot interleave.
//
// Ported from block/buzz's `buzz-audit` crate (per-entry hash over canonical
// JSON + previous hash, single-writer serialization, verify operation).

export type AuditActorType = 'user' | 'agent' | 'service' | 'system'
export type AuditOutcome = 'success' | 'denied' | 'error'

/**
 * The semantic fields a caller supplies for one audit entry. `prevHash`,
 * `entryHash`, `createdAt`, and `id` are NOT part of this input — the write path
 * derives `prevHash`/`entryHash` and stamps `createdAt`.
 */
export type AuditEntryInput = {
  organizationId: string
  projectId?: string | null
  teamId?: string | null
  channelId?: string | null
  actorType: AuditActorType
  actorId: string
  action: string
  resourceType: string
  resourceId?: string | null
  outcome: AuditOutcome
  reason?: string | null
  metadata?: Prisma.InputJsonValue | null
  requestId: string
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively so that
 * two structurally-equal values always produce the same bytes. `undefined` is
 * treated as `null`. This is what the SHA-256 digest is taken over, so it must
 * never change without a chain-version bump.
 */
export const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`
}

/**
 * The exact, fixed set of fields covered by the hash, in a normalized shape
 * (missing/undefined optionals become explicit `null`). Covered fields:
 * action, actorId, actorType, channelId, createdAt (ISO 8601), ipAddress,
 * metadata, organizationId, outcome, prevHash, projectId, reason, requestId,
 * resourceId, resourceType, teamId, userAgent. The row `id` is intentionally
 * excluded (a random UUID carries no integrity meaning); `entryHash` is the
 * output, not an input.
 */
export const buildCanonicalAuditPayload = (
  input: AuditEntryInput,
  meta: { createdAt: Date; prevHash: string | null },
): Record<string, unknown> => ({
  action: input.action,
  actorId: input.actorId,
  actorType: input.actorType,
  channelId: input.channelId ?? null,
  createdAt: meta.createdAt.toISOString(),
  ipAddress: input.ipAddress ?? null,
  metadata: input.metadata ?? null,
  organizationId: input.organizationId,
  outcome: input.outcome,
  prevHash: meta.prevHash,
  projectId: input.projectId ?? null,
  reason: input.reason ?? null,
  requestId: input.requestId,
  resourceId: input.resourceId ?? null,
  resourceType: input.resourceType,
  teamId: input.teamId ?? null,
  userAgent: input.userAgent ?? null,
})

/** SHA-256 (hex) over the canonical serialization of the payload. */
export const computeEntryHash = (payload: Record<string, unknown>): string =>
  createHash('sha256').update(stableStringify(payload)).digest('hex')

const acquireOrgAuditLock = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> => {
  // Transaction-scoped advisory lock keyed on the organization id, matching the
  // established pattern (agent-tool-policy, deepwater-activation, etc.). It
  // serializes the tip-read + insert so concurrent writers for one org cannot
  // fork the chain.
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`audit_chain:${organizationId}`}, 0)
    )
  `)
}

/**
 * Append one entry to the organization's audit hash chain. Runs in its own
 * interactive transaction: take the org advisory lock, read the current chain
 * tip's `entryHash`, compute this entry's `entryHash`, and insert. Pre-chain
 * epoch rows (`entryHash IS NULL`, written before this feature existed) are
 * ignored when locating the tip, so the chain simply starts at the first new
 * row per organization with `prevHash = null`.
 */
export const writeAuditEntryInTransaction = async (
  tx: Prisma.TransactionClient,
  input: AuditEntryInput,
): Promise<void> => {
  await acquireOrgAuditLock(tx, input.organizationId)

  const tip = await tx.auditLog.findFirst({
    where: { organizationId: input.organizationId, entryHash: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { entryHash: true, createdAt: true },
  })

  const prevHash = tip?.entryHash ?? null
    // Make per-org `createdAt` strictly monotonic within the serialized chain.
    // Postgres timestamp(3) is millisecond precision, and two lock-serialized
    // writes can still land in the same millisecond; without this bump the
    // ascending-createdAt verify walk (and the descending tip read) could
    // disagree with the actual chain-link order and falsely report a break.
    // A +1ms bump makes [createdAt asc] alone a total per-org insertion order.
  const createdAt = new Date(
    tip ? Math.max(Date.now(), tip.createdAt.getTime() + 1) : Date.now(),
  )
  const entryHash = computeEntryHash(
    buildCanonicalAuditPayload(input, { createdAt, prevHash }),
  )

  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      teamId: input.teamId ?? null,
      channelId: input.channelId ?? null,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome,
      reason: input.reason ?? null,
      metadata: input.metadata ?? undefined,
      requestId: input.requestId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      createdAt,
      prevHash,
      entryHash,
    },
  })
}

export const writeAuditEntry = async (
  prisma: PrismaClient,
  input: AuditEntryInput,
): Promise<void> =>
  prisma.$transaction((tx) => writeAuditEntryInTransaction(tx, input))

export type AuditChainVerification = {
  valid: boolean
  checkedCount: number
  firstBreak?: { id: string; reason: string }
}

type AuditChainRow = {
  id: string
  organizationId: string
  projectId: string | null
  teamId: string | null
  channelId: string | null
  actorType: AuditActorType
  actorId: string
  action: string
  resourceType: string
  resourceId: string | null
  outcome: AuditOutcome
  reason: string | null
  metadata: Prisma.JsonValue
  requestId: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  prevHash: string | null
  entryHash: string | null
}

const rowToInput = (row: AuditChainRow): AuditEntryInput => ({
  organizationId: row.organizationId,
  projectId: row.projectId,
  teamId: row.teamId,
  channelId: row.channelId,
  actorType: row.actorType,
  actorId: row.actorId,
  action: row.action,
  resourceType: row.resourceType,
  resourceId: row.resourceId,
  outcome: row.outcome,
  reason: row.reason,
  metadata: (row.metadata ?? null) as Prisma.InputJsonValue | null,
  requestId: row.requestId,
  ipAddress: row.ipAddress,
  userAgent: row.userAgent,
})

/**
 * Walk an organization's audit hash chain in insertion order and confirm every
 * entry's `prevHash` links to its predecessor and its `entryHash` matches a
 * fresh recomputation. Returns the first break (a deleted/inserted/reordered or
 * content-mutated entry), if any.
 *
 * Streams the chain in pages (default 500 rows) via a keyset cursor so an
 * arbitrarily long chain never loads fully into memory. Pre-chain epoch rows
 * (`entryHash IS NULL`) are skipped.
 */
export const verifyAuditChain = async (
  prisma: PrismaClient,
  organizationId: string,
  options: { pageSize?: number; maxEntries?: number } = {},
): Promise<AuditChainVerification> => {
  const pageSize = Math.min(Math.max(options.pageSize ?? 500, 1), 2000)
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY

  let checkedCount = 0
  let expectedPrevHash: string | null = null
  let cursor: { createdAt: Date; id: string } | null = null

  for (;;) {
    const rows: AuditChainRow[] = await prisma.auditLog.findMany({
      where: {
        organizationId,
        entryHash: { not: null },
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
    })

    if (rows.length === 0) break

    for (const row of rows) {
      if (row.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          checkedCount,
          firstBreak: {
            id: row.id,
            reason: expectedPrevHash === null ? 'unexpected_prev_hash' : 'broken_link',
          },
        }
      }

      const recomputed = computeEntryHash(
        buildCanonicalAuditPayload(rowToInput(row), {
          createdAt: row.createdAt,
          prevHash: row.prevHash,
        }),
      )
      if (recomputed !== row.entryHash) {
        return {
          valid: false,
          checkedCount,
          firstBreak: { id: row.id, reason: 'entry_hash_mismatch' },
        }
      }

      checkedCount += 1
      expectedPrevHash = row.entryHash
      cursor = { createdAt: row.createdAt, id: row.id }

      if (checkedCount >= maxEntries) {
        return { valid: true, checkedCount }
      }
    }

    if (rows.length < pageSize) break
  }

  return { valid: true, checkedCount }
}
