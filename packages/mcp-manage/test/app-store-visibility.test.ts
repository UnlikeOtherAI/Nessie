import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'

import { storeCatalogWhere } from '../src/index.js'

/**
 * What the App Store is allowed to list. The store migration backfilled
 * `curated` onto every pre-existing non-public catalog entry, so the curation
 * qualifier asserted below is the only thing keeping one member's private draft
 * connector out of everybody else's store.
 */

const ORG = '00000000-0000-4000-8000-00000000000a'
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b'
const ADA = '00000000-0000-4000-8000-0000000000c1'
const GRACE = '00000000-0000-4000-8000-0000000000c2'

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

const actor = (userId: string, organizationId = ORG): AuthorizedActionContext =>
  ({
    tenant: { organizationId },
    actor: { actorId: userId, actorType: 'user' },
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
