import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import type { AppCategory, AuthorizedActionContext } from '@nessie/schemas'

import {
  catalogTenancyWhere,
  compileCatalogWhere,
  searchStoreApps,
  storeCatalogWhere,
} from '../src/index.js'

/**
 * The two halves of the store's search that only a real database can answer.
 *
 * 1. **The compiled SQL predicate and `storeCatalogWhere` select the same
 *    rows.** The ranking query cannot hydrate a candidate list first, so it
 *    carries the visibility rule itself — and a hand-written `WHERE` there is
 *    the one place the tenancy floor could be dropped without anything else
 *    noticing. Comparing the compiler's output to a hand-written expectation
 *    would only restate it; running both against the same rows does not.
 * 2. **Rank comes from the trigger-maintained `search_vector` weights.** An
 *    alias is weight A and prose is weight D, so "pentestrix" must reach the
 *    app that lists it as an alias before the one that merely mentions it — a
 *    property of the index, not of any TypeScript this suite could exercise.
 *
 * Everything is seeded inside a throwaway organisation and deleted afterwards,
 * so the rows are invisible to every other suite sharing this database (they
 * fail the tenancy floor) and no global count is asserted. The predicate
 * agreement is read inside one `RepeatableRead` snapshot precisely because
 * another suite may be writing catalogue rows at the same time.
 */

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const actorIn = (organizationId: string, userId: string): AuthorizedActionContext =>
  ({
    tenant: { organizationId },
    actor: { actorId: userId, actorType: 'user', roles: [] },
    actionContext: {},
  }) as unknown as AuthorizedActionContext

type EntrySeed = {
  label: string
  moderationState: 'discovered' | 'curated' | 'approved' | 'hidden'
  trustLevel?: 'nessie' | 'verified' | 'community' | 'unknown' | 'blocked'
  visibility?: 'public' | 'private'
  status?: 'draft' | 'pending_approval' | 'published' | 'rejected' | 'deprecated'
  ownerUserId?: string | null
  description?: string
  aliases?: string[]
  primaryCategory?: AppCategory
}

const seedEntry = async (
  prisma: PrismaClient,
  organizationId: string,
  seed: EntrySeed,
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
      moderationState: seed.moderationState,
      trustLevel: seed.trustLevel ?? 'community',
      visibility: seed.visibility ?? 'public',
      status: seed.status ?? 'published',
      ownerUserId: seed.ownerUserId ?? null,
      aliases: seed.aliases ?? [],
      primaryCategory: seed.primaryCategory ?? 'development',
    },
    select: { id: true },
  })
  return created.id
}

type Fixture = {
  prisma: PrismaClient
  orgId: string
  otherOrgId: string
  adaId: string
  graceId: string
  cleanup: () => Promise<void>
}

const openFixture = async (): Promise<Fixture> => {
  const prisma = new PrismaClient()
  const stamp = randomUUID()
  const [org, otherOrg] = await Promise.all([
    prisma.organization.create({ data: { name: `app-search ${stamp}` }, select: { id: true } }),
    prisma.organization.create({ data: { name: `app-search alt ${stamp}` }, select: { id: true } }),
  ])
  const [ada, grace] = await Promise.all([
    prisma.user.create({
      data: { email: `ada-${stamp}@app-search.test`, displayName: 'Ada' },
      select: { id: true },
    }),
    prisma.user.create({
      data: { email: `grace-${stamp}@app-search.test`, displayName: 'Grace' },
      select: { id: true },
    }),
  ])
  const cleanup = async (): Promise<void> => {
    await prisma.mcpCatalogEntry.deleteMany({
      where: { organizationId: { in: [org.id, otherOrg.id] } },
    })
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id] } } })
    await prisma.user.deleteMany({ where: { id: { in: [ada.id, grace.id] } } })
    await prisma.$disconnect()
  }
  return {
    prisma,
    orgId: org.id,
    otherOrgId: otherOrg.id,
    adaId: ada.id,
    graceId: grace.id,
    cleanup,
  }
}

/** Both readings of the same clause, over whatever the catalogue holds. */
const idsBothWays = async (
  prisma: PrismaClient,
  where: Prisma.McpCatalogEntryWhereInput,
): Promise<{ viaPrisma: string[]; viaSql: string[] }> =>
  prisma.$transaction(
    async (tx) => {
      const rows = await tx.mcpCatalogEntry.findMany({ where, select: { id: true } })
      const raw = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT e."id"::text AS id
        FROM "mcp_catalog_entries" e
        WHERE ${compileCatalogWhere(where)}
      `)
      return {
        viaPrisma: rows.map((row) => row.id).sort(),
        viaSql: raw.map((row) => row.id).sort(),
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )

runIfDatabase('the compiled SQL predicate lists exactly what the Prisma store clause lists', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, otherOrgId, adaId, graceId } = fixture
  try {
    const listed = {
      approved: await seedEntry(prisma, orgId, { label: 'Listed Approved', moderationState: 'approved' }),
      curatedPublic: await seedEntry(prisma, orgId, {
        label: 'Listed Curated', moderationState: 'curated',
      }),
      ownDraft: await seedEntry(prisma, orgId, {
        label: 'Ada Draft', moderationState: 'curated', visibility: 'private', status: 'draft',
        ownerUserId: adaId,
      }),
    }
    const withheld = {
      otherDraft: await seedEntry(prisma, orgId, {
        label: 'Grace Draft', moderationState: 'curated', visibility: 'private', status: 'draft',
        ownerUserId: graceId,
      }),
      hidden: await seedEntry(prisma, orgId, { label: 'Rejected', moderationState: 'hidden' }),
      blocked: await seedEntry(prisma, orgId, {
        label: 'Blocked', moderationState: 'approved', trustLevel: 'blocked',
      }),
      undiscovered: await seedEntry(prisma, orgId, {
        label: 'Registry Row', moderationState: 'discovered',
      }),
      foreign: await seedEntry(prisma, otherOrgId, {
        label: 'Other Org', moderationState: 'approved',
      }),
    }

    const ada = await idsBothWays(prisma, storeCatalogWhere(actorIn(orgId, adaId)))
    // The agreement is the point; the membership assertions below are what stop
    // it passing vacuously on an empty or uniform catalogue.
    assert.deepEqual(ada.viaSql, ada.viaPrisma)
    for (const id of Object.values(listed)) assert.ok(ada.viaPrisma.includes(id), `missing ${id}`)
    for (const id of Object.values(withheld)) assert.ok(!ada.viaPrisma.includes(id), `leaked ${id}`)

    // Grace sees the same organisation minus Ada's private draft, plus her own.
    const grace = await idsBothWays(prisma, storeCatalogWhere(actorIn(orgId, graceId)))
    assert.deepEqual(grace.viaSql, grace.viaPrisma)
    assert.ok(!grace.viaPrisma.includes(listed.ownDraft))
    assert.ok(grace.viaPrisma.includes(withheld.otherDraft))

    // And a caller in the other organisation reaches none of it, both ways.
    const outsider = await idsBothWays(prisma, storeCatalogWhere(actorIn(otherOrgId, adaId)))
    assert.deepEqual(outsider.viaSql, outsider.viaPrisma)
    for (const id of Object.values(listed)) assert.ok(!outsider.viaPrisma.includes(id))
    assert.ok(outsider.viaPrisma.includes(withheld.foreign))
  } finally {
    await fixture.cleanup()
  }
})

runIfDatabase('a person can add the same private app name in separate organisations', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, otherOrgId, adaId } = fixture
  const name = `private-app-${randomUUID()}`
  try {
    const create = (organizationId: string) =>
      prisma.mcpCatalogEntry.create({
        data: {
          organizationId,
          name,
          label: 'Private app',
          description: '',
          protocol: 'http',
          authMethod: 'none',
          createdBy: adaId,
          ownerUserId: adaId,
          moderationState: 'curated',
          visibility: 'private',
          status: 'published',
        },
        select: { id: true, organizationId: true },
      })

    const [first, second] = await Promise.all([create(orgId), create(otherOrgId)])
    assert.notEqual(first.id, second.id)
    assert.notEqual(first.organizationId, second.organizationId)

    // The new index permits the independent rows; the tenancy floor must still
    // make each one visible only in the team where its owner added it.
    const firstTeam = await idsBothWays(prisma, storeCatalogWhere(actorIn(orgId, adaId)))
    assert.deepEqual(firstTeam.viaSql, firstTeam.viaPrisma)
    assert.ok(firstTeam.viaPrisma.includes(first.id))
    assert.ok(!firstTeam.viaPrisma.includes(second.id))

    const secondTeam = await idsBothWays(prisma, storeCatalogWhere(actorIn(otherOrgId, adaId)))
    assert.deepEqual(secondTeam.viaSql, secondTeam.viaPrisma)
    assert.ok(!secondTeam.viaPrisma.includes(first.id))
    assert.ok(secondTeam.viaPrisma.includes(second.id))
  } finally {
    await fixture.cleanup()
  }
})

runIfDatabase('the tenancy floor reaches the instance own rows under both readings', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, adaId } = fixture
  // `organization_id IS NULL` is the arm no organisation-scoped seed can reach,
  // and a compiler that rendered it wrong would hide the first-party apps rather
  // than leak anything — which is why it needs its own row. It is seeded
  // `discovered`, so while it exists it is invisible to every store read in
  // every other suite sharing this database.
  const firstParty = await prisma.mcpCatalogEntry.create({
    data: {
      organizationId: null,
      name: `first-party-${randomUUID()}`,
      label: 'Instance Row',
      description: 'not listed anywhere',
      protocol: 'http',
      authMethod: 'none',
      createdBy: randomUUID(),
      moderationState: 'discovered',
      visibility: 'private',
      status: 'draft',
    },
    select: { id: true },
  })
  try {
    const floor = {
      AND: [catalogTenancyWhere(actorIn(orgId, adaId)), { moderationState: 'discovered' as const }],
    }
    const both = await idsBothWays(prisma, floor)
    assert.deepEqual(both.viaSql, both.viaPrisma)
    assert.ok(both.viaPrisma.includes(firstParty.id))
  } finally {
    await prisma.mcpCatalogEntry.delete({ where: { id: firstParty.id } })
    await fixture.cleanup()
  }
})

runIfDatabase('an alias match outranks a description match', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, adaId } = fixture
  try {
    // A token nothing else in the catalogue can match, so the assertion is about
    // these two rows and not about whatever else the instance has ingested.
    const token = 'pentestrix'
    const alias = await seedEntry(prisma, orgId, {
      label: 'DeepTest', moderationState: 'approved', aliases: [token],
      description: 'security review companion',
    })
    // Sorts first alphabetically, so a tie on rank would put it ahead: the
    // assertion fails unless the weights are doing the work.
    const prose = await seedEntry(prisma, orgId, {
      label: 'Aardvark Notes', moderationState: 'approved',
      description: `a ${token} report writer for ${token} findings and ${token} retests`,
    })

    const found = await searchStoreApps(prisma, {
      where: storeCatalogWhere(actorIn(orgId, adaId)),
      query: token,
      connectedIds: [],
      limit: 100,
    })

    assert.deepEqual(found.ids, [alias, prose])
    assert.equal(found.countsByCategory.get('development'), 2)
  } finally {
    await fixture.cleanup()
  }
})

runIfDatabase('the counts are the whole match set while the rows stop at the limit', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, adaId } = fixture
  try {
    const token = 'quokkatronic'
    for (let index = 0; index < 4; index += 1) {
      await seedEntry(prisma, orgId, {
        label: `Quokka ${index}`, moderationState: 'approved', aliases: [token],
      })
    }
    await seedEntry(prisma, orgId, {
      label: 'Quokka Analytics', moderationState: 'approved', aliases: [token],
      primaryCategory: 'analytics',
    })

    const found = await searchStoreApps(prisma, {
      where: storeCatalogWhere(actorIn(orgId, adaId)),
      query: token,
      connectedIds: [],
      limit: 2,
    })

    // "Show all 5" from a page of 2 — the number the screen says out loud can
    // only come from the count query.
    assert.equal(found.ids.length, 2)
    assert.equal(found.countsByCategory.get('development'), 4)
    assert.equal(found.countsByCategory.get('analytics'), 1)

    // The category filter narrows the slice and leaves those counts alone.
    const narrowed = await searchStoreApps(prisma, {
      where: storeCatalogWhere(actorIn(orgId, adaId)),
      query: token,
      category: 'analytics',
      connectedIds: [],
      limit: 100,
    })
    assert.equal(narrowed.ids.length, 1)
    assert.equal(narrowed.countsByCategory.get('development'), 4)
  } finally {
    await fixture.cleanup()
  }
})

runIfDatabase('equally relevant apps put the caller own connections first', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, adaId } = fixture
  try {
    const token = 'wobblenaut'
    // Same shape, same alias, so the weights score them identically and the
    // tiebreak is the only thing left to decide the order.
    const ids: string[] = []
    for (const suffix of ['Alpha', 'Bravo', 'Charlie']) {
      ids.push(await seedEntry(prisma, orgId, {
        label: `Wobble ${suffix}`, moderationState: 'approved', aliases: [token],
      }))
    }

    const byName = await searchStoreApps(prisma, {
      where: storeCatalogWhere(actorIn(orgId, adaId)),
      query: token,
      connectedIds: [],
      limit: 100,
    })
    assert.deepEqual(byName.ids, ids, 'a rank tie falls back to the rendered name')

    const connectedLast = await searchStoreApps(prisma, {
      where: storeCatalogWhere(actorIn(orgId, adaId)),
      query: token,
      connectedIds: [ids[2] as string],
      limit: 100,
    })
    assert.deepEqual(connectedLast.ids, [ids[2], ids[0], ids[1]])
  } finally {
    await fixture.cleanup()
  }
})

runIfDatabase('a mistyped query falls through to the trigram lane, still inside the floor', async () => {
  const fixture = await openFixture()
  const { prisma, orgId, otherOrgId, adaId } = fixture
  try {
    const mine = await seedEntry(prisma, orgId, {
      label: 'Zyxwomble', moderationState: 'approved',
    })
    const foreign = await seedEntry(prisma, otherOrgId, {
      label: 'Zyxwomble', moderationState: 'approved',
    })

    const found = await searchStoreApps(prisma, {
      where: storeCatalogWhere(actorIn(orgId, adaId)),
      query: 'zyxwomble',
      connectedIds: [],
      limit: 100,
    })
    assert.deepEqual(found.ids, [mine])

    const mistyped = await searchStoreApps(prisma, {
      where: storeCatalogWhere(actorIn(orgId, adaId)),
      query: 'zyxwomblle',
      connectedIds: [],
      limit: 100,
    })
    // The fallback lane compiles and runs the same predicate: a fuzzy match is
    // still only ever a match inside the caller's own tenancy.
    assert.ok(mistyped.ids.includes(mine))
    assert.ok(!mistyped.ids.includes(foreign))
  } finally {
    await fixture.cleanup()
  }
})
