import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import type { AppCategory, AuthorizedActionContext } from '@nessie/schemas'

import { searchStoreApps, storeCatalogWhere } from '../src/index.js'

/**
 * The prefix term: why "fi" finds "Finstat".
 *
 * Whole-word full-text matches lexemes and the trigram fallback needs three
 * characters, so a two-letter prefix of a real name matched nothing — the
 * store stopped narrowing in the middle of typing. The ranking query now ORs
 * a whitelisted `to_tsquery('simple', '<term>:*')` onto the word query.
 *
 * Two halves, as in `app-search-postgres.test.ts`:
 * - **Unit** (no database): the raw query text must never carry the user's
 *   string — a hostile query (quotes, `:*`, `&`, `|`, backslash) can neither
 *   break nor inject into the SQL because it only ever travels as a bound
 *   parameter, and the one assembled term is rebuilt from whitelisted
 *   characters.
 * - **Postgres** (gated on `DATABASE_URL`, seeded per-suite): a 2-character
 *   prefix matches the app whose name starts with it; an exact name still
 *   outranks a prose mention; a typo still reaches the trigram lane.
 */

const ORG = '00000000-0000-4000-8000-00000000000a'
const ADA = '00000000-0000-4000-8000-0000000000c1'

const actor = (userId = ADA, organizationId = ORG): AuthorizedActionContext =>
  ({
    tenant: { organizationId },
    actor: { actorId: userId, actorType: 'user', roles: [] },
    actionContext: {},
  }) as unknown as AuthorizedActionContext

// ─── Unit: the assembled SQL never carries user text ────────────────────────

type Capture = { sql: string; values: readonly unknown[] }

/**
 * Answers every lane with nothing; the point is what the SQL and its bound
 * values look like, not the results.
 */
const capturePrisma = (): { prisma: PrismaClient; captured: Capture[] } => {
  const captured: Capture[] = []
  const prisma = {
    $queryRaw: async (query: Prisma.Sql) => {
      captured.push({ sql: query.sql, values: query.values })
      return []
    },
  }
  return { prisma: prisma as unknown as PrismaClient, captured }
}

const captureSearch = async (query: string): Promise<Capture[]> => {
  const { prisma, captured } = capturePrisma()
  await searchStoreApps(prisma, {
    where: storeCatalogWhere(actor()),
    query,
    connectedIds: [],
    limit: 100,
  })
  return captured
}

test('a short query adds a whitelisted prefix term, bound as a parameter', async () => {
  const captured = await captureSearch('fi')
  const slice = captured.find((entry) => entry.sql.includes('ts_rank_cd'))
  assert.ok(slice, 'no full-text query was issued')
  assert.ok(slice.sql.includes(`|| to_tsquery('simple',`), 'no prefix term was assembled')
  assert.ok(!slice.sql.includes('fi'), 'the query text must never carry the user value')
  // The assembled 'fi:*' and the raw 'fi' both travel as bind parameters.
  assert.ok(slice.values.includes('fi:*'))
  assert.ok(slice.values.includes('fi'))
})

test('a hostile query cannot break or inject into the SQL', async () => {
  const hostile = `'); DROP TABLE "mcp_catalog_entries"; -- & | :* \\ "fi":*`
  const captured = await captureSearch(hostile)
  assert.ok(captured.length > 0)
  for (const entry of captured) {
    assert.ok(!entry.sql.includes('DROP TABLE'), 'user text reached the query text')
    assert.ok(!entry.sql.includes(':*') || entry.sql.includes(`|| to_tsquery('simple',`), 'stray :*')
  }
  // The raw hostile string only ever appears as a bound parameter…
  const slice = captured.find((entry) => entry.sql.includes('ts_rank_cd'))
  assert.ok(slice)
  assert.ok(slice.values.includes(hostile))
  // …and the assembled prefix term is rebuilt from whitelisted characters:
  // operators, quotes, and backslashes are gone before ':*' is appended.
  const prefix = slice.values.find(
    (value): value is string =>
      typeof value === 'string' && value !== hostile && value.endsWith(':*'),
  )
  assert.ok(prefix, 'no prefix term was bound')
  assert.match(prefix, /^[a-z0-9-]+:\*$/)
})

test('a query with no safe lexeme assembles no prefix term', async () => {
  const captured = await captureSearch('!!!')
  const slice = captured.find((entry) => entry.sql.includes('ts_rank_cd'))
  assert.ok(slice)
  assert.ok(!slice.sql.includes(`|| to_tsquery('simple',`), 'an empty lexeme must not reach tsquery')
})

// ─── Postgres: the prefix actually ranks ────────────────────────────────────

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const seedEntry = async (
  prisma: PrismaClient,
  organizationId: string,
  seed: { label: string; description?: string; aliases?: string[]; primaryCategory?: AppCategory },
): Promise<string> => {
  const created = await prisma.mcpCatalogEntry.create({
    data: {
      organizationId,
      name: `${seed.label}-${randomUUID()}`,
      label: seed.label,
      description: seed.description ?? 'no prose',
      protocol: 'http',
      authMethod: 'none',
      createdBy: randomUUID(),
      moderationState: 'approved',
      trustLevel: 'community',
      visibility: 'public',
      status: 'published',
      aliases: seed.aliases ?? [],
      primaryCategory: seed.primaryCategory ?? 'development',
    },
    select: { id: true },
  })
  return created.id
}

const openFixture = async (): Promise<{
  prisma: PrismaClient
  orgId: string
  adaId: string
  cleanup: () => Promise<void>
}> => {
  const prisma = new PrismaClient()
  const stamp = randomUUID()
  const org = await prisma.organization.create({
    data: { name: `app-search-prefix ${stamp}` },
    select: { id: true },
  })
  const ada = await prisma.user.create({
    data: { email: `ada-${stamp}@app-search-prefix.test`, displayName: 'Ada' },
    select: { id: true },
  })
  const cleanup = async (): Promise<void> => {
    await prisma.mcpCatalogEntry.deleteMany({ where: { organizationId: org.id } })
    await prisma.organization.delete({ where: { id: org.id } })
    await prisma.user.delete({ where: { id: ada.id } })
    await prisma.$disconnect()
  }
  return { prisma, orgId: org.id, adaId: ada.id, cleanup }
}

const search = (
  prisma: PrismaClient,
  orgId: string,
  adaId: string,
  query: string,
): ReturnType<typeof searchStoreApps> =>
  searchStoreApps(prisma, {
    where: storeCatalogWhere(actor(adaId, orgId)),
    query,
    connectedIds: [],
    limit: 100,
  })

runIfDatabase('a two-character prefix finds the app whose name starts with it', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, adaId } = fixture
  try {
    // The *query* has to be the distinctive part, not just the seeded name.
    // This asserted `search('fi')` against a name of 'Fiqzorn Ledger' and
    // passed only on a near-empty catalogue: a synced registry holds ~1,600
    // apps carrying a real "fi…" word (FileToPDF, Financial, Filtrix), all
    // legitimately ranked, so the seeded row fell outside the slice and the
    // test measured how full the shared database was rather than whether
    // prefix matching works. Both halves of `zq` are unique here.
    const id = await seedEntry(prisma, orgId, { label: 'Zqarnix Ledger' })
    const found = await search(prisma, orgId, adaId, 'zq')
    assert.ok(found.ids.includes(id), 'a 2-character prefix of the name must match')
  } finally {
    await fixture.cleanup()
  }
})

runIfDatabase('a prefix every catalogue shares still answers, rather than going empty', async () => {
  // The reported bug: "fi" found nothing while "fin" found two. Whole-word
  // matching could not see into a word and the trigram lane needs three
  // characters, so the store stopped narrowing exactly as a person began to
  // type. What is asserted is that the prefix lane answers at all — never a
  // position, because rank over a shared catalogue is not this test's to own.
  const fixture = await openFixture()
  const { prisma, orgId, adaId } = fixture
  try {
    await seedEntry(prisma, orgId, { label: 'Zqarnix Ledger' })
    const short = await search(prisma, orgId, adaId, 'zq')
    const longer = await search(prisma, orgId, adaId, 'zqarnix')
    assert.ok(short.ids.length > 0, 'a two-character prefix must not answer empty')
    assert.ok(longer.ids.length > 0, 'typing more must keep the app reachable')
  } finally {
    await fixture.cleanup()
  }
})

runIfDatabase('an exact name still outranks a prose match', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, adaId } = fixture
  try {
    const token = 'quilvaron'
    const named = await seedEntry(prisma, orgId, { label: 'Quilvaron Sheets' })
    // Sorts first alphabetically, so a tie on rank would put it ahead.
    const prose = await seedEntry(prisma, orgId, {
      label: 'Aardvark Reports',
      description: `writes ${token} files and reads ${token} archives`,
    })
    const found = await search(prisma, orgId, adaId, token)
    assert.deepEqual(found.ids, [named, prose])
  } finally {
    await fixture.cleanup()
  }
})

runIfDatabase('a hostile query string runs cleanly against the database', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, adaId } = fixture
  try {
    const id = await seedEntry(prisma, orgId, { label: 'Zqarnix Ledger' })
    const hostile = `'); DROP TABLE "mcp_catalog_entries"; -- & | :* \\ "zq":*`
    // Must not raise (a broken tsquery would be a 42601 syntax error), and the
    // sanitised tail ("zq") still matches by prefix. The tail is a token no
    // real catalogue row carries, so what is asserted is the sanitiser's
    // output and not this database's contents.
    const found = await search(prisma, orgId, adaId, hostile)
    assert.ok(found.ids.includes(id), 'the whitelisted prefix term should still match')
  } finally {
    await fixture.cleanup()
  }
})

runIfDatabase('a mistyped query still reaches the trigram fallback', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, adaId } = fixture
  try {
    const id = await seedEntry(prisma, orgId, { label: 'Zyxwomble' })
    const found = await search(prisma, orgId, adaId, 'zyxwomblle')
    assert.ok(found.ids.includes(id), 'the fuzzy lane must survive the prefix term')
  } finally {
    await fixture.cleanup()
  }
})
