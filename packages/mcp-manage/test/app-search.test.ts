import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, type PrismaClient } from '@prisma/client'
import type { AppCategory, AuthorizedActionContext } from '@nessie/schemas'

import { compileCatalogWhere, searchStoreApps, storeCatalogWhere } from '../src/index.js'

/**
 * The store's search must cost the same whether the catalogue holds five apps
 * or fifty thousand.
 *
 * The shape this replaced hydrated every store-visible row into the API process
 * and sent its ids back down as `id IN ($1, $2, …)` — one bind parameter per
 * catalogue row, per 150 ms-debounced keystroke, twice when the fuzzy lane ran,
 * and a hard failure past PostgreSQL's 65,535-parameter ceiling. So the fake
 * client below deliberately exposes **only** `$queryRaw`: a search that tried
 * to enumerate the catalogue through `mcpCatalogEntry.findMany` would not fail
 * an assertion here, it would throw.
 */

const ORG = '00000000-0000-4000-8000-00000000000a'
const ADA = '00000000-0000-4000-8000-0000000000c1'

const actor = (userId = ADA, organizationId = ORG): AuthorizedActionContext =>
  ({
    tenant: { organizationId },
    actor: { actorId: userId, actorType: 'user', roles: [] },
    actionContext: {},
  }) as unknown as AuthorizedActionContext

type Capture = { sql: string; text: string; values: readonly unknown[] }

type LaneAnswer = { ids: string[]; counts: Array<[AppCategory, number]> }

const NOTHING: LaneAnswer = { ids: [], counts: [] }

/**
 * Answers the two queries each lane issues, chosen by what the SQL asks for —
 * so the test never has to assume the order they were dispatched in.
 */
const fakePrisma = (
  answers: { fullText?: LaneAnswer; trigram?: LaneAnswer },
): { prisma: PrismaClient; captured: Capture[] } => {
  const captured: Capture[] = []
  const prisma = {
    $queryRaw: async (query: Prisma.Sql) => {
      captured.push({ sql: query.sql, text: query.text, values: query.values })
      const lane = query.sql.includes('ts_rank_cd')
        ? answers.fullText ?? NOTHING
        : answers.trigram ?? NOTHING
      if (query.sql.includes('count(*)')) {
        return lane.counts.map(([category, total]) => ({ category, total }))
      }
      return lane.ids.map((id) => ({ id }))
    },
  }
  return { prisma: prisma as unknown as PrismaClient, captured }
}

const search = async (
  answers: { fullText?: LaneAnswer; trigram?: LaneAnswer },
  options: { query?: string; category?: AppCategory; connectedIds?: string[]; limit?: number } = {},
): Promise<{ result: Awaited<ReturnType<typeof searchStoreApps>>; captured: Capture[] }> => {
  const { prisma, captured } = fakePrisma(answers)
  const result = await searchStoreApps(prisma, {
    where: storeCatalogWhere(actor()),
    query: options.query ?? 'pentest',
    category: options.category,
    connectedIds: options.connectedIds ?? [],
    limit: options.limit ?? 100,
  })
  return { result, captured }
}

const sliceQuery = (captured: Capture[]): Capture => {
  const found = captured.find((entry) => !entry.sql.includes('count(*)'))
  assert.ok(found, 'no slice query was issued')
  return found
}

const countQuery = (captured: Capture[]): Capture => {
  const found = captured.find((entry) => entry.sql.includes('count(*)'))
  assert.ok(found, 'no count query was issued')
  return found
}

const oneCategory = (rows: number): LaneAnswer => ({
  ids: Array.from({ length: Math.min(rows, 100) }, (_, index) => `id-${index}`),
  counts: [['development', rows]],
})

// ─── Bounded work ───────────────────────────────────────────────────────────

test('the bind-parameter cost of a search does not grow with the catalogue', async () => {
  const small = await search({ fullText: oneCategory(12) })
  const huge = await search({ fullText: oneCategory(20_000) })

  const shape = (captured: Capture[]): number[] => captured.map((entry) => entry.values.length)
  // Not "similar" — identical. A candidate id list would make the second run's
  // parameter count 20,000 higher than the first's.
  assert.deepEqual(shape(huge.captured), shape(small.captured))
  // And small in absolute terms: the query text, the visibility clause, and the
  // limit. Nothing per row.
  const widest = Math.max(...shape(huge.captured))
  assert.ok(widest <= 16, `expected a handful of parameters, got ${widest}`)
})

test('the slice is ordered and cut inside the query, not after it', async () => {
  const { captured } = await search({ fullText: oneCategory(20_000) }, { limit: 100 })

  const slice = sliceQuery(captured)
  assert.match(slice.sql, /ORDER BY m\."rank" DESC/)
  assert.match(slice.sql, /LIMIT \?/)
  assert.equal(slice.values.at(-1), 100)
})

test('a rank tie prefers an app this caller has already connected, decided in SQL', async () => {
  const connected = ['00000000-0000-4000-8000-0000000000f1']
  const { captured } = await search({ fullText: oneCategory(3) }, { connectedIds: connected })

  const slice = sliceQuery(captured)
  // Applied to the returned slice instead, a tie straddling the limit would be
  // resolved by whichever half happened to be returned.
  assert.match(slice.sql, /\(m\."id" IN \(\?::uuid\)\) DESC/)
  assert.ok(slice.values.includes(connected[0]))
})

// ─── Honest counts ──────────────────────────────────────────────────────────

test('per-category totals are the SQL aggregate, not a tally of the returned slice', async () => {
  const { result, captured } = await search({
    fullText: { ids: ['a', 'b', 'c'], counts: [['development', 412], ['productivity', 57]] },
  })

  // "Show all 412" must not be counted off a list of three.
  assert.equal(result.ids.length, 3)
  assert.equal(result.countsByCategory.get('development'), 412)
  assert.equal(result.countsByCategory.get('productivity'), 57)

  const counts = countQuery(captured)
  assert.match(counts.sql, /GROUP BY m\."primary_category"/)
  assert.doesNotMatch(counts.sql, /LIMIT/)
})

test('the category filter narrows the slice and leaves the counts describing every category', async () => {
  const { captured } = await search(
    { fullText: oneCategory(9) },
    { category: 'development' },
  )

  assert.match(sliceQuery(captured).sql, /m\."primary_category" = \?/)
  assert.doesNotMatch(countQuery(captured).sql, /primary_category" = /)
})

// ─── Lanes ──────────────────────────────────────────────────────────────────

test('the fuzzy lane runs only when the words matched nothing at all', async () => {
  const matched = await search({ fullText: oneCategory(4), trigram: oneCategory(99) })
  assert.equal(matched.captured.length, 2)
  assert.ok(matched.captured.every((entry) => entry.sql.includes('ts_rank_cd')))
  // A real word match must never be reordered by fuzzy noise.
  assert.equal(matched.result.countsByCategory.get('development'), 4)

  const mistyped = await search({ trigram: { ids: ['x'], counts: [['development', 1]] } })
  assert.equal(mistyped.captured.length, 4)
  assert.deepEqual(mistyped.result.ids, ['x'])
})

test('an empty query asks the database nothing', async () => {
  const { result, captured } = await search({ fullText: oneCategory(4) }, { query: '   ' })
  assert.deepEqual(captured, [])
  assert.deepEqual(result.ids, [])
  assert.equal(result.countsByCategory.size, 0)
})

// ─── The visibility floor ───────────────────────────────────────────────────

test('both lanes carry the compiled store clause verbatim', async () => {
  const predicate = compileCatalogWhere(storeCatalogWhere(actor())).sql
  const { captured } = await search({ trigram: { ids: ['x'], counts: [['development', 1]] } })

  // Substring, not a hand-written expectation: the lanes are pinned to the same
  // clause the rest of the store reads with, and this is the one place a
  // hand-written WHERE could quietly drop the tenancy floor.
  for (const entry of captured.filter((query) => !query.sql.includes('count(*)'))) {
    assert.ok(entry.sql.includes(predicate), `lane lost the store clause:\n${entry.sql}`)
  }
  assert.ok(predicate.includes('"e"."organization_id"'))
})

test('the search text is a bound parameter, never text spliced into SQL', async () => {
  const hostile = `o'brien'); DROP TABLE mcp_catalog_entries; --`
  const { captured } = await search({ fullText: oneCategory(1) }, { query: hostile })

  for (const entry of captured) {
    assert.ok(!entry.text.includes('DROP TABLE'), `query text carried user input:\n${entry.text}`)
  }
  assert.ok(sliceQuery(captured).values.includes(hostile))
})

test('a clause term the compiler does not understand fails loudly instead of being dropped', async () => {
  const { prisma } = fakePrisma({})
  const attempt = async (where: Prisma.McpCatalogEntryWhereInput): Promise<void> => {
    await searchStoreApps(prisma, { where, query: 'x', connectedIds: [], limit: 10 })
  }

  // Silently skipping an unmapped term would widen the result set — the exact
  // failure mode that leaks another organisation's rows.
  await assert.rejects(attempt({ name: 'anything' }), /no SQL binding/)
  await assert.rejects(attempt({ organizationId: { not: ORG } }), /NULL handling/)
  await assert.rejects(
    attempt({ AND: { moderationState: 'approved' } as never }),
    /must be an array/,
  )
})

test('an empty installed filter selects nothing rather than everything', async () => {
  // `{ id: { in: [] } }` is what `?installed=1` compiles to for a caller with no
  // connections; rendering it as an absent term would list the whole store.
  const { prisma, captured } = fakePrisma({ fullText: oneCategory(3) })
  await searchStoreApps(prisma, {
    where: { AND: [storeCatalogWhere(actor()), { id: { in: [] } }] },
    query: 'pentest',
    connectedIds: [],
    limit: 10,
  })
  assert.match(sliceQuery(captured).sql, /FALSE/)
})
