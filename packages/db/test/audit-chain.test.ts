import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  buildCanonicalAuditPayload,
  computeEntryHash,
  stableStringify,
  verifyAuditChain,
  writeAuditEntry,
  type AuditEntryInput,
} from '../src/audit-chain.js'

const baseInput = (overrides: Partial<AuditEntryInput> = {}): AuditEntryInput => ({
  organizationId: 'org-1',
  actorType: 'user',
  actorId: 'actor-1',
  action: 'kb.page.published',
  resourceType: 'knowledge_page',
  resourceId: 'page-1',
  outcome: 'success',
  requestId: 'req-1',
  metadata: { provider: 'slack', nested: { b: 2, a: 1 } },
  ...overrides,
})

// A stored chain entry as Prisma would return it (createdAt is a Date).
type StoredRow = {
  id: string
  organizationId: string
  projectId: string | null
  teamId: string | null
  channelId: string | null
  actorType: 'user' | 'agent' | 'service' | 'system'
  actorId: string
  action: string
  resourceType: string
  resourceId: string | null
  outcome: 'success' | 'denied' | 'error'
  reason: string | null
  metadata: unknown
  requestId: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  prevHash: string | null
  entryHash: string | null
}

// --- Canonical serialization + hash: golden vector -------------------------

test('stableStringify sorts object keys recursively and normalizes nullish', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}')
  assert.equal(stableStringify(undefined), 'null')
  assert.equal(stableStringify(null), 'null')
  assert.equal(stableStringify([3, { z: 1, a: 2 }]), '[3,{"a":2,"z":1}]')
  // Key order in the input must not change the output.
  assert.equal(
    stableStringify({ a: 1, b: 2 }),
    stableStringify({ b: 2, a: 1 }),
  )
})

test('computeEntryHash matches the frozen golden vector', () => {
  const payload = buildCanonicalAuditPayload(baseInput(), {
    createdAt: new Date('2026-07-23T00:00:00.000Z'),
    prevHash: null,
  })
  assert.equal(
    computeEntryHash(payload),
    'e113dae9a13eed4fc5bb14123845f92972789c4bc6d25dbb44477fefa393b881',
  )
})

test('metadata key order does not change the entry hash', () => {
  const meta = { createdAt: new Date('2026-07-23T00:00:00.000Z'), prevHash: null }
  const a = computeEntryHash(
    buildCanonicalAuditPayload(baseInput({ metadata: { x: 1, y: 2 } }), meta),
  )
  const b = computeEntryHash(
    buildCanonicalAuditPayload(baseInput({ metadata: { y: 2, x: 1 } }), meta),
  )
  assert.equal(a, b)
})

// --- Write path: chain linking (genesis + subsequent) ----------------------

const buildWriterPrisma = (
  initial: StoredRow[] = [],
  makeId: (seq: number) => string = (seq) => `row-${seq}`,
) => {
  const rows: StoredRow[] = [...initial]
  let seq = rows.length
  const prisma = {
    $executeRaw: async () => undefined,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    auditLog: {
      findFirst: async (args: {
        where: { entryHash?: { not: null } }
      }): Promise<{ entryHash: string | null; createdAt: Date } | null> => {
        // Mirrors the tip lookup: latest row with a non-null entryHash.
        const chained = rows
          .filter((r) => r.entryHash !== null)
          .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1))
        return chained[0]
          ? { entryHash: chained[0].entryHash, createdAt: chained[0].createdAt }
          : null
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1
        const id = makeId(seq)
        rows.push({ id, ...(data as unknown as Omit<StoredRow, 'id'>) })
        return { id }
      },
    },
  }
  return { prisma: prisma as unknown as PrismaClient, rows }
}

test('writeAuditEntry: first entry is genesis (prevHash null), second links to first', async () => {
  const { prisma, rows } = buildWriterPrisma()

  await writeAuditEntry(prisma, baseInput())
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.prevHash, null)
  assert.ok(rows[0]?.entryHash)

  await writeAuditEntry(prisma, baseInput({ action: 'kb.page.deleted', resourceId: 'page-2' }))
  assert.equal(rows.length, 2)
  assert.equal(rows[1]?.prevHash, rows[0]?.entryHash)
  assert.notEqual(rows[1]?.entryHash, rows[0]?.entryHash)

  const verification = await verifyAuditChain(makeVerifyPrisma(rows), 'org-1')
  assert.deepEqual(verification, { valid: true, checkedCount: 2 })
})

test('writeAuditEntry: pre-chain epoch rows (null entryHash) are ignored for the tip', async () => {
  const epochRow: StoredRow = {
    id: 'legacy-1',
    organizationId: 'org-1',
    projectId: null,
    teamId: null,
    channelId: null,
    actorType: 'user',
    actorId: 'old-actor',
    action: 'legacy.action',
    resourceType: 'thing',
    resourceId: null,
    outcome: 'success',
    reason: null,
    metadata: null,
    requestId: 'legacy-req',
    ipAddress: null,
    userAgent: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    prevHash: null,
    entryHash: null,
  }
  const { prisma, rows } = buildWriterPrisma([epochRow])

  await writeAuditEntry(prisma, baseInput())
  // The first NEW row must be genesis, not chained off the legacy null row.
  assert.equal(rows.length, 2)
  assert.equal(rows[1]?.prevHash, null)
  assert.ok(rows[1]?.entryHash)
})

// --- Regression: monotonic createdAt under a frozen clock ------------------

const withFrozenClock = async (fixedMs: number, fn: () => Promise<void>) => {
  const original = Date.now
  Date.now = () => fixedMs
  try {
    await fn()
  } finally {
    Date.now = original
  }
}

test('writeAuditEntry: createdAt is strictly monotonic even with a frozen clock', async () => {
  const { prisma, rows } = buildWriterPrisma()
  const fixed = Date.UTC(2026, 6, 23, 12, 0, 0)

  await withFrozenClock(fixed, async () => {
    await writeAuditEntry(prisma, baseInput({ action: 'a.0' }))
    await writeAuditEntry(prisma, baseInput({ action: 'a.1' }))
    await writeAuditEntry(prisma, baseInput({ action: 'a.2' }))
  })

  assert.equal(rows.length, 3)
  // Same wall-clock millisecond for all three; the +1ms bump separates them.
  assert.equal(rows[0]?.createdAt.getTime(), fixed)
  assert.equal(rows[1]?.createdAt.getTime(), fixed + 1)
  assert.equal(rows[2]?.createdAt.getTime(), fixed + 2)
  // Chain still links tip-to-tip.
  assert.equal(rows[1]?.prevHash, rows[0]?.entryHash)
  assert.equal(rows[2]?.prevHash, rows[1]?.entryHash)

  const verification = await verifyAuditChain(makeVerifyPrisma(rows), 'org-1')
  assert.deepEqual(verification, { valid: true, checkedCount: 3 })
})

test('writeAuditEntry: inverted UUIDs no longer false-flag (createdAt is the order)', async () => {
  // ids descend as the chain grows (row 1 -> 'id-8', row 2 -> 'id-7', ...), the
  // exact case that made a [createdAt asc, id asc] walk visit a successor before
  // its predecessor and report a bogus broken_link. The monotonic createdAt bump
  // makes createdAt alone the authoritative order, so verify passes.
  const { prisma, rows } = buildWriterPrisma([], (seq) => `id-${9 - seq}`)
  const fixed = Date.UTC(2026, 6, 23, 12, 0, 0)

  await withFrozenClock(fixed, async () => {
    await writeAuditEntry(prisma, baseInput({ action: 'a.0' }))
    await writeAuditEntry(prisma, baseInput({ action: 'a.1' }))
    await writeAuditEntry(prisma, baseInput({ action: 'a.2' }))
  })

  // Confirm the ids really are inverted vs. insertion order.
  assert.deepEqual(rows.map((r) => r.id), ['id-8', 'id-7', 'id-6'])

  const verification = await verifyAuditChain(makeVerifyPrisma(rows), 'org-1')
  assert.deepEqual(verification, { valid: true, checkedCount: 3 })
})

// --- Verify: paginated read over a fixed set of stored rows ----------------

const makeVerifyPrisma = (rows: StoredRow[]): PrismaClient => {
  const prisma = {
    auditLog: {
      findMany: async (args: {
        where: {
          entryHash?: { not: null }
          OR?: Array<{ createdAt?: unknown; id?: unknown }>
        }
        take: number
      }): Promise<StoredRow[]> => {
        let list = rows
          .filter((r) => r.entryHash !== null)
          .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : 1))
        const or = args.where.OR
        if (or) {
          // Keyset cursor: strictly after (createdAt, id).
          const gt = or[0]?.createdAt as { gt: Date } | undefined
          const tie = or[1] as { createdAt: Date; id: { gt: string } } | undefined
          list = list.filter((r) => {
            if (gt && r.createdAt.getTime() > gt.gt.getTime()) return true
            if (tie && r.createdAt.getTime() === tie.createdAt.getTime() && r.id > tie.id.gt) {
              return true
            }
            return false
          })
        }
        return list.slice(0, args.take)
      },
    },
  }
  return prisma as unknown as PrismaClient
}

const buildChainedRows = (n: number): StoredRow[] => {
  const rows: StoredRow[] = []
  let prevHash: string | null = null
  for (let i = 0; i < n; i += 1) {
    const createdAt = new Date(Date.UTC(2026, 6, 23, 0, 0, i))
    const input = baseInput({ action: `act.${i}`, resourceId: `res-${i}` })
    const entryHash = computeEntryHash(buildCanonicalAuditPayload(input, { createdAt, prevHash }))
    rows.push({
      id: `row-${i}`,
      organizationId: input.organizationId,
      projectId: null,
      teamId: null,
      channelId: null,
      actorType: 'user',
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      outcome: 'success',
      reason: null,
      metadata: input.metadata ?? null,
      requestId: input.requestId,
      ipAddress: null,
      userAgent: null,
      createdAt,
      prevHash,
      entryHash,
    })
    prevHash = entryHash
  }
  return rows
}

test('verifyAuditChain: valid chain passes, paging across multiple pages', async () => {
  const rows = buildChainedRows(7)
  const result = await verifyAuditChain(makeVerifyPrisma(rows), 'org-1', { pageSize: 2 })
  assert.deepEqual(result, { valid: true, checkedCount: 7 })
})

test('verifyAuditChain: detects a mutated middle entry', async () => {
  const rows = buildChainedRows(5)
  // Tamper with the content of the middle entry WITHOUT recomputing its hash.
  rows[2] = { ...rows[2], action: 'act.TAMPERED' } as StoredRow
  const result = await verifyAuditChain(makeVerifyPrisma(rows), 'org-1', { pageSize: 10 })
  assert.equal(result.valid, false)
  assert.equal(result.checkedCount, 2)
  assert.equal(result.firstBreak?.id, 'row-2')
  assert.equal(result.firstBreak?.reason, 'entry_hash_mismatch')
})

test('verifyAuditChain: detects a deleted middle entry (broken link)', async () => {
  const rows = buildChainedRows(5)
  rows.splice(2, 1) // remove the middle entry; row-3's prevHash now dangles
  const result = await verifyAuditChain(makeVerifyPrisma(rows), 'org-1', { pageSize: 10 })
  assert.equal(result.valid, false)
  assert.equal(result.firstBreak?.id, 'row-3')
  assert.equal(result.firstBreak?.reason, 'broken_link')
})

test('verifyAuditChain: empty chain is valid with zero checked', async () => {
  const result = await verifyAuditChain(makeVerifyPrisma([]), 'org-1')
  assert.deepEqual(result, { valid: true, checkedCount: 0 })
})
