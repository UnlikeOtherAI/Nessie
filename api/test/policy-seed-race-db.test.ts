import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { runReconcile } from '../src/db/reconcile-cli.js'
import {
  NEW_ORGANIZATION_DEFAULT_POLICIES,
  seedDefaultPolicies,
} from '../src/services/policy-seed.js'

/**
 * Default policy seeding used to be a count-then-create with no lock and no
 * unique constraint, so two boots racing on one organisation inserted the
 * default set twice and left duplicate rules at equal priority — which made
 * `resolveDecision` answer by row order (horizontal-scaling audit 1.4).
 *
 * The fix is `PolicyRule.seedKey` plus the partial unique index
 * `policy_rules_organization_id_seed_key_key`, written through
 * `createMany({ skipDuplicates: true })` under
 * `pg_advisory_xact_lock('policy-seed:<org>')`.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * `runReconcile` and the migration's collapse statement both walk EVERY
 * organisation, so they mutate rows this suite does not own — the one thing the
 * shared test database forbids (docs/standards/testing.md). They therefore need
 * a database of their own and stay opt-in, the same way
 * `team-bootstrap-postgres-race.test.ts` does. Run them with:
 *   DATABASE_URL=<dedicated db> NESSIE_TEST_PRISTINE_DATABASE=1 \
 *     node --test --import tsx test/policy-seed-race-db.test.ts
 */
const exclusiveDbTest =
  process.env.DATABASE_URL && process.env.NESSIE_TEST_PRISTINE_DATABASE === '1'
    ? test
    : test.skip

const DEFAULT_COUNT = NEW_ORGANIZATION_DEFAULT_POLICIES.length

type Fixture = { organizationId: string; ownerId: string; prisma: PrismaClient }

const seedOrganization = async (label: string): Promise<Fixture> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const ownerId = randomUUID()
  await prisma.organization.create({
    data: { id: organizationId, name: `${label}-${organizationId}` },
  })
  await prisma.user.create({
    data: {
      displayName: `Policy seed ${organizationId.slice(0, 8)}`,
      email: `${ownerId}@policy-seed.test`,
      id: ownerId,
    },
  })
  await prisma.organizationMember.create({
    data: { organizationId, role: 'owner', userId: ownerId },
  })
  return { organizationId, ownerId, prisma }
}

const teardown = async (fixture: Fixture): Promise<void> => {
  await fixture.prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
  await fixture.prisma.user.deleteMany({ where: { id: fixture.ownerId } })
  await fixture.prisma.$disconnect()
}

const seedKeyCounts = async (
  fixture: Fixture,
): Promise<Map<string | null, number>> => {
  const rules = await fixture.prisma.policyRule.findMany({
    select: { seedKey: true },
    where: { organizationId: fixture.organizationId },
  })
  const counts = new Map<string | null, number>()
  for (const rule of rules) {
    counts.set(rule.seedKey, (counts.get(rule.seedKey) ?? 0) + 1)
  }
  return counts
}

// Fails without the fix on the row count: two unlocked, unconstrained seeders
// both read zero rules and both insert the whole default set, so the
// organisation ends up with 2 x DEFAULT_COUNT rules and every seed key twice.
dbTest('concurrent seeds of one fresh organisation write exactly one default set', async () => {
  const fixture = await seedOrganization('policy-seed-race')
  try {
    const { organizationId, ownerId, prisma } = fixture
    const [first, second] = await Promise.all([
      prisma.$transaction((tx) => seedDefaultPolicies(tx, organizationId, ownerId)),
      prisma.$transaction((tx) => seedDefaultPolicies(tx, organizationId, ownerId)),
    ])

    const counts = await seedKeyCounts(fixture)
    assert.equal(
      [...counts.values()].reduce((total, count) => total + count, 0),
      DEFAULT_COUNT,
      'the organisation holds exactly one default set',
    )
    for (const rule of NEW_ORGANIZATION_DEFAULT_POLICIES) {
      assert.equal(counts.get(rule.seedKey), 1, `one row for ${rule.seedKey}`)
    }
    assert.equal(
      first.rulesCreated + second.rulesCreated,
      DEFAULT_COUNT,
      'between them the two callers created the set once',
    )

    // One `role` binding per rule, and no duplicate bindings either.
    const bindings = await prisma.policyBinding.count({
      where: { policyRule: { is: { organizationId } } },
    })
    assert.equal(bindings, DEFAULT_COUNT)
  } finally {
    await teardown(fixture)
  }
})

// The sequential half of the same guarantee, and the one the login path relies
// on: `ensureTeamPrincipal` seeds a freshly materialized organisation, and the
// reconcile job seeds it again on the next deploy.
dbTest('re-seeding an already seeded organisation creates nothing', async () => {
  const fixture = await seedOrganization('policy-seed-idempotent')
  try {
    const { organizationId, ownerId, prisma } = fixture
    const first = await prisma.$transaction((tx) =>
      seedDefaultPolicies(tx, organizationId, ownerId))
    const second = await prisma.$transaction((tx) =>
      seedDefaultPolicies(tx, organizationId, ownerId))

    assert.equal(first.rulesCreated, DEFAULT_COUNT)
    assert.equal(first.bindingsCreated, DEFAULT_COUNT)
    assert.equal(second.rulesCreated, 0)
    assert.equal(second.bindingsCreated, 0)
    assert.equal(
      await prisma.policyRule.count({ where: { organizationId } }),
      DEFAULT_COUNT,
    )
  } finally {
    await teardown(fixture)
  }
})

// Fails without the fix on the second summary: an unconstrained seeder inserts
// the default set again on every reconcile, so `policyRulesCreated` never
// returns to zero and the row count grows with each deploy.
exclusiveDbTest('runReconcile twice leaves identical row counts', async () => {
  const fixture = await seedOrganization('policy-seed-reconcile')
  try {
    const { organizationId, prisma } = fixture
    const first = await runReconcile(prisma, () => {})
    const afterFirst = await prisma.policyRule.count({ where: { organizationId } })
    const grantsAfterFirst = await prisma.toolGrant.count()

    const second = await runReconcile(prisma, () => {})
    const afterSecond = await prisma.policyRule.count({ where: { organizationId } })

    assert.equal(afterFirst, DEFAULT_COUNT, 'the first run seeded the default set')
    assert.ok(first.organizations >= 1)
    assert.equal(afterSecond, afterFirst, 'the second run added no policy rules')
    assert.equal(second.policyRulesCreated, 0)
    assert.equal(second.policyBindingsCreated, 0)
    assert.equal(second.protectedGrantsCreated, 0)
    assert.equal(second.assistantGrantsCreated, 0)
    assert.equal(await prisma.toolGrant.count(), grantsAfterFirst)
  } finally {
    await teardown(fixture)
  }
})

/**
 * The migration's collapse statement, read from the file it ships in so the
 * test exercises the SQL that actually runs on a deploy rather than a copy of
 * it. The markers are in `migration.sql` and are documented there.
 */
const collapseStatement = (): string => {
  const path = resolve(
    import.meta.dirname,
    '../prisma/migrations/20260907130000_policy_rule_seed_key/migration.sql',
  )
  const sql = readFileSync(path, 'utf8')
  const start = sql.indexOf('-- >>> collapse-default-policy-duplicates')
  const end = sql.indexOf('-- <<< collapse-default-policy-duplicates')
  assert.ok(start >= 0 && end > start, 'the collapse markers are present')
  return sql.slice(start, end)
}

// The migration stamps a survivor with the seed key the seeder would have
// written, so its VALUES list and the catalogue above have to say the same
// thing. Drift between them would leave a duplicate the seeder then re-inserts.
// No database needed, so this one runs everywhere.
test('the migration matches the default policy catalogue', () => {
  const rows = [...collapseStatement().matchAll(
    /\(\s*'(default:[^']+)'(?:::text)?,\s*'([^']+)'(?:::text)?,\s*'([^']+)'(?:::text)?,\s*'([^']+)'(?:::text)?,\s*(\d+),\s*'([^']+)'(?:::text)?\s*\)/g,
  )].map((match) => ({
    actorId: match[6],
    action: match[3],
    effect: match[4],
    priority: Number(match[5]),
    resourceType: match[2],
    seedKey: match[1],
  }))
  assert.deepEqual(
    rows,
    NEW_ORGANIZATION_DEFAULT_POLICIES.map((rule) => ({ ...rule })),
  )
})

// Fails without the fix by construction: the duplicates below are exactly what
// the pre-fix path left in production, and nothing removed them.
exclusiveDbTest('the collapse statement leaves one default set on a twice-seeded org', async () => {
  const fixture = await seedOrganization('policy-seed-collapse')
  try {
    const { organizationId, ownerId, prisma } = fixture

    // Reproduce the pre-fix path: the same default set written twice, with no
    // seed key, exactly as the count-then-create seeder wrote it.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const rule of NEW_ORGANIZATION_DEFAULT_POLICIES) {
        const created = await prisma.policyRule.create({
          data: {
            action: rule.action as Exclude<typeof rule.action, 'export' | 'import'>,
            createdBy: ownerId,
            effect: rule.effect,
            organizationId,
            priority: rule.priority,
            resourceType: rule.resourceType,
            scope: 'organization',
            scopeId: organizationId,
          },
          select: { id: true },
        })
        await prisma.policyBinding.create({
          data: { actorId: rule.actorId, actorType: 'role', policyRuleId: created.id },
        })
      }
    }
    assert.equal(
      await prisma.policyRule.count({ where: { organizationId } }),
      DEFAULT_COUNT * 2,
      'the pre-fix duplicates are in place',
    )

    await prisma.$executeRawUnsafe(collapseStatement())

    const counts = await seedKeyCounts(fixture)
    assert.equal(counts.get(null), undefined, 'every survivor carries its seed key')
    for (const rule of NEW_ORGANIZATION_DEFAULT_POLICIES) {
      assert.equal(counts.get(rule.seedKey), 1, `one row survives for ${rule.seedKey}`)
    }
    assert.equal(
      await prisma.policyRule.count({ where: { organizationId } }),
      DEFAULT_COUNT,
    )
    // The survivors keep their bindings; the losers took theirs with them.
    assert.equal(
      await prisma.policyBinding.count({ where: { policyRule: { is: { organizationId } } } }),
      DEFAULT_COUNT,
    )
  } finally {
    await teardown(fixture)
  }
})
