import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  approveSubmission,
  deprecateCatalogEntry,
  rejectSubmission,
  storeCatalogWhere,
} from '../src/index.js'

/**
 * What the App Store is allowed to list. The store migration backfilled
 * `curated` onto every pre-existing non-public catalog entry, so the curation
 * qualifier asserted below is the only thing keeping one member's private draft
 * connector out of everybody else's store.
 *
 * The second half of the file asserts the other side of "one catalogue, two
 * faces": each lifecycle transition is *run*, and the row it leaves behind is
 * then handed to the real store clause. A shape assertion alone cannot catch a
 * transition that forgets to record its decision — which is exactly how a
 * rejected and a deprecated entry both stayed listed to their owner.
 */

const ORG = '00000000-0000-4000-8000-00000000000a'
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b'
const ADA = '00000000-0000-4000-8000-0000000000c1'
const GRACE = '00000000-0000-4000-8000-0000000000c2'
/** The instance super-admin — the only reviewer of public submissions. */
const ROOT = '00000000-0000-4000-8000-0000000000c3'

/**
 * The clause reduced to the operators it actually uses, so the nesting can be
 * walked in a test without reaching through Prisma's union-typed `AND`/`OR`.
 */
type Clause = {
  AND?: Clause[]
  OR?: Clause[]
  moderationState?: string
  organizationId?: string | null
  ownerUserId?: string
  status?: string
  trustLevel?: { not: string }
  visibility?: string
}

const actor = (
  userId: string,
  organizationId = ORG,
  roles: string[] = [],
): AuthorizedActionContext =>
  ({
    tenant: { organizationId },
    actor: { actorId: userId, actorType: 'user', roles },
    actionContext: {},
  }) as unknown as AuthorizedActionContext

const clauseFor = (userId: string, organizationId = ORG): Clause =>
  storeCatalogWhere(actor(userId, organizationId)) as unknown as Clause

test('the store clause is the tenancy floor AND the curation rule, never merged into one object', () => {
  // Both are top-level `OR`s: spreading them into a single object would keep
  // one key and silently drop the other, which is how a tenancy floor vanishes.
  assert.deepEqual(clauseFor(ADA), {
    trustLevel: { not: 'blocked' },
    AND: [
      { OR: [{ organizationId: null }, { organizationId: ORG }] },
      {
        OR: [
          { moderationState: 'approved' },
          {
            AND: [
              { moderationState: 'curated' },
              {
                OR: [
                  { visibility: 'public', status: 'published' },
                  { ownerUserId: ADA },
                ],
              },
            ],
          },
        ],
      },
    ],
  })
})

test('the tenancy floor admits the instance own rows plus the caller organisation, nothing else', () => {
  assert.deepEqual(clauseFor(ADA, OTHER_ORG).AND?.[0], {
    OR: [{ organizationId: null }, { organizationId: OTHER_ORG }],
  })
})

test('a blocked trust level is excluded whoever asks', () => {
  assert.deepEqual(clauseFor(ADA).trustLevel, { not: 'blocked' })
  assert.deepEqual(clauseFor(GRACE, OTHER_ORG).trustLevel, { not: 'blocked' })
})

test('approved is admitted unconditionally — a human already made that decision', () => {
  assert.deepEqual(clauseFor(ADA).AND?.[1]?.OR?.[0], { moderationState: 'approved' })
})

test('a curated entry is listed only when published publicly or owned by the caller', () => {
  // Never a bare `{ moderationState: 'curated' }`: the migration put that state
  // on every pre-existing private row, so unqualified it would list them all.
  assert.deepEqual(clauseFor(ADA).AND?.[1]?.OR?.[1], {
    AND: [
      { moderationState: 'curated' },
      { OR: [{ visibility: 'public', status: 'published' }, { ownerUserId: ADA }] },
    ],
  })
})

test('the curated owner escape hatch names the caller alone, so another member draft stays hidden', () => {
  const ownerTermFor = (userId: string): Clause | undefined =>
    clauseFor(userId).AND?.[1]?.OR?.[1]?.AND?.[1]?.OR?.[1]

  // Grace's private curated draft is neither public+published nor owned by Ada,
  // so no disjunct in Ada's clause reaches it — and vice versa.
  assert.deepEqual(ownerTermFor(ADA), { ownerUserId: ADA })
  assert.deepEqual(ownerTermFor(GRACE), { ownerUserId: GRACE })
})

// ─── The two faces, driven end to end ───────────────────────────────────────
//
// Run the real transition against an in-memory catalogue, then ask the real
// `storeCatalogWhere` about the row it left behind. Anything the transition
// forgets to write shows up here as an app still on the shelf.

type StoreRow = {
  id: string
  organizationId: string | null
  name: string
  ownerUserId: string | null
  status: string
  visibility: string
  moderationState: string
  trustLevel: string
}

/**
 * Enough of Prisma's `where` grammar to evaluate the clauses these services
 * build: `AND`/`OR` nesting, `not`, `in`, and plain equality. Any other
 * operator — a relation filter such as the managed-product guard's
 * `integratedProducts: { some: … }` — deliberately fails to match rather than
 * being approximated: this evaluator exists to exercise the store clause, not
 * to reimplement the query planner.
 */
const matchesWhere = (row: StoreRow, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === 'AND') {
      return (value as Array<Record<string, unknown>>).every((c) => matchesWhere(row, c))
    }
    if (key === 'OR') {
      return (value as Array<Record<string, unknown>>).some((c) => matchesWhere(row, c))
    }
    const actual = (row as unknown as Record<string, unknown>)[key]
    if (value !== null && typeof value === 'object') {
      const operator = value as { not?: unknown; in?: unknown[] }
      if ('not' in operator) return actual !== operator.not
      if ('in' in operator) return (operator.in ?? []).includes(actual)
      return false
    }
    return actual === value
  })

const isListedInStore = (row: StoreRow, viewer: string): boolean =>
  matchesWhere(row, storeCatalogWhere(actor(viewer)) as unknown as Record<string, unknown>)

const makeCatalogue = (
  seed: StoreRow[],
  superAdmins: string[] = [],
): { prisma: PrismaClient; read: (id: string) => StoreRow } => {
  const rows = new Map(seed.map((row) => [row.id, row]))
  const read = (id: string): StoreRow => {
    const row = rows.get(id)
    if (!row) throw new Error(`catalogue row ${id} is missing`)
    return row
  }
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        superAdmin: superAdmins.includes(where.id),
      }),
    },
    mcpCatalogEntry: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].find((row) => matchesWhere(row, where)) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const next = { ...read(args.where.id), ...args.data } as StoreRow
        rows.set(next.id, next)
        return next
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matched = [...rows.values()].filter((row) => matchesWhere(row, args.where))
        for (const row of matched) rows.set(row.id, { ...row, ...args.data } as StoreRow)
        return { count: matched.length }
      },
    },
  }
  return { prisma: prisma as unknown as PrismaClient, read }
}

/** Ada's connector, submitted and awaiting the super-admin's decision. */
const pendingSubmission = (): StoreRow => ({
  id: 'entry-1',
  organizationId: ORG,
  name: 'ada-tool',
  ownerUserId: ADA,
  status: 'pending_approval',
  visibility: 'public',
  moderationState: 'curated',
  trustLevel: 'unverified',
})

// The reviewer is the instance super-admin; the `owner` role is what makes a
// not-yet-published submission readable to them at all.
const reviewer = actor(ROOT, ORG, ['owner'])

test('an approved submission is listed, and the row says approval is why', async () => {
  const { prisma, read } = makeCatalogue([pendingSubmission()], [ROOT])

  const result = await approveSubmission(prisma, reviewer, 'entry-1')

  assert.equal(result?.status, 'published')
  const row = read('entry-1')
  // Not merely "public + published so the curation arm happens to reach it":
  // the decision is in the column the store reads.
  assert.equal(row.moderationState, 'approved')
  assert.equal(isListedInStore(row, GRACE), true)
  assert.equal(isListedInStore(row, ADA), true)
})

test('a rejected submission is not listed in the store, not even to its owner', async () => {
  const { prisma, read } = makeCatalogue([pendingSubmission()], [ROOT])
  // Precondition, so the assertion below cannot pass for the wrong reason: while
  // it is pending, the curated owner arm does list it to Ada.
  assert.equal(isListedInStore(pendingSubmission(), ADA), true)

  await rejectSubmission(prisma, reviewer, 'entry-1', 'Needs a clearer description')

  const row = read('entry-1')
  assert.equal(row.status, 'rejected')
  assert.equal(row.moderationState, 'hidden')
  assert.equal(isListedInStore(row, ADA), false)
  assert.equal(isListedInStore(row, GRACE), false)
})

test('a deprecated entry is not listed in the store, not even to its owner', async () => {
  const retired = (): StoreRow => ({
    ...pendingSubmission(),
    status: 'published',
    visibility: 'private',
  })
  const { prisma, read } = makeCatalogue([retired()])
  assert.equal(isListedInStore(retired(), ADA), true)

  await deprecateCatalogEntry(prisma, actor(ADA), 'entry-1')

  const row = read('entry-1')
  assert.equal(row.status, 'deprecated')
  assert.equal(row.moderationState, 'hidden')
  // Otherwise the owner keeps an app card — Connect action included — for a
  // connector that was just withdrawn.
  assert.equal(isListedInStore(row, ADA), false)
})

test('deprecating an approved public app takes it off the shelf for everyone', async () => {
  // `approved` is admitted unconditionally, so only the state write can retire
  // this row; a read-side status filter is not what is doing the work here.
  const listed = (): StoreRow => ({
    ...pendingSubmission(),
    status: 'published',
    moderationState: 'approved',
  })
  const { prisma, read } = makeCatalogue([listed()])
  assert.equal(isListedInStore(listed(), GRACE), true)

  await deprecateCatalogEntry(prisma, actor(ADA), 'entry-1')

  assert.equal(isListedInStore(read('entry-1'), GRACE), false)
})
