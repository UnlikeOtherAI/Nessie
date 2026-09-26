import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'

import {
  calculateEstimatedCost,
  findActivePricingProfile,
  recomputeTokenLedgerCosts,
} from '../src/ledger-pricing.js'

// A Prisma Decimal is a `{ toNumber(): number }` at runtime.
const dec = (value: number): { toNumber(): number } => ({ toNumber: () => value })

type Row = {
  id: string
  modelPattern: string
  source: 'provider_default' | 'org_override' | 'team_override' | 'manual'
  inputPerMillion: number
}

const profileRow = (row: Row) => ({
  cacheReadPerMillion: null,
  cacheWritePerMillion: null,
  cachedInputPerMillion: null,
  cachedOutputPerMillion: null,
  currency: 'USD',
  effectiveFrom: new Date('2026-09-01T00:00:00Z'),
  id: row.id,
  inputPerMillion: dec(row.inputPerMillion),
  modelPattern: row.modelPattern,
  outputPerMillion: null,
  source: row.source,
})

const pricingPrisma = (rows: Row[]) =>
  ({
    modelPricingProfile: {
      findMany: async () => rows.map(profileRow),
    },
  }) as unknown as PrismaClient

const winner = async (rows: Row[]) =>
  (await findActivePricingProfile(pricingPrisma(rows), 'org-1', 'openai', 'gpt-5-mini'))?.id

// docs/token-ledger-spec.md §4: an owner's price beats the model service's
// published one whatever its specificity, and inside each an exact model beats
// the provider-wide `*`. The published prices are seeded for every model, so an
// order that only compared patterns would let them override an owner's `*`.
test('an owner price wins over a published one, and exact wins over *', async () => {
  const published = { id: 'published-exact', modelPattern: 'gpt-5-mini', source: 'provider_default', inputPerMillion: 1 } as const
  const publishedWildcard = { id: 'published-any', modelPattern: '*', source: 'provider_default', inputPerMillion: 2 } as const
  const ownerWildcard = { id: 'owner-any', modelPattern: '*', source: 'manual', inputPerMillion: 3 } as const
  const ownerExact = { id: 'owner-exact', modelPattern: 'gpt-5-mini', source: 'manual', inputPerMillion: 4 } as const

  assert.equal(await winner([published, publishedWildcard, ownerWildcard, ownerExact]), 'owner-exact')
  assert.equal(await winner([published, publishedWildcard, ownerWildcard]), 'owner-any')
  assert.equal(await winner([publishedWildcard, published]), 'published-exact')
  assert.equal(await winner([publishedWildcard]), 'published-any')
  assert.equal(await winner([]), undefined)
})

test('an estimate is null only when no price is known', () => {
  assert.equal(calculateEstimatedCost({ inputTokens: 1_000_000 }, null), null)
  const pricing = {
    cacheReadPerMillion: null,
    cacheWritePerMillion: null,
    cachedInputPerMillion: null,
    cachedOutputPerMillion: null,
    currency: 'USD',
    id: 'p',
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    source: 'provider_default' as const,
  }
  assert.equal(calculateEstimatedCost({ inputTokens: 2_000_000, outputTokens: 500_000 }, pricing), 1.5)
})

// Personal plans and an own computer are left unpriced on purpose by the usage
// writer. Re-pricing "events with no estimate" must not read that as "events
// whose price was unknown", or seeding the published prices would charge the
// organisation for work it never paid for.
test('re-pricing touches only usage paid through the model service', async () => {
  const groupByWheres: unknown[] = []
  const statements: string[] = []
  const prisma = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      statements.push(strings.join('?'))
      return 3
    },
    modelPricingProfile: {
      findMany: async () => [
        profileRow({ id: 'published', modelPattern: 'gpt-5-mini', source: 'provider_default', inputPerMillion: 1 }),
      ],
    },
    tokenLedgerEvent: {
      groupBy: async (args: { where: unknown }) => {
        groupByWheres.push(args.where)
        return [{ model: 'gpt-5-mini', provider: 'openai' }]
      },
    },
  } as unknown as PrismaClient

  const result = await recomputeTokenLedgerCosts(prisma, 'org-1')

  assert.deepEqual(result, { pricedPairs: 1, unpricedPairs: 0, updatedEvents: 3 })
  assert.deepEqual(groupByWheres, [
    { billingSource: 'ledger', estimatedCostAmount: null, organizationId: 'org-1' },
  ])
  assert.equal(statements.length, 1)
  assert.match(statements[0] ?? '', /billing_source = 'ledger'/)
  assert.match(statements[0] ?? '', /estimated_cost_amount IS NULL/)
})
