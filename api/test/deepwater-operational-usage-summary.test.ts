import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'

import { listIntegratedProducts } from '../src/services/integrations.js'
import { getConnectorUsageSummary } from '../src/services/token-ledger.js'

test('connector operational summaries exclude every DeepWater cost marker', async () => {
  const statements: string[] = []
  const prisma = {
    $queryRawUnsafe: async (statement: string) => {
      statements.push(statement)
      return statements.length === 1
        ? [{ total_calls: 1n, total_cost: 0, total_units: 2n }]
        : [{ calls: 1n, cost: 0, key: 'mcp', units: 2n }]
    },
  } as unknown as PrismaClient

  const summary = await getConnectorUsageSummary(
    prisma,
    '8f3a5a00-0e64-4d10-a517-0d0b69c1d401',
    { groupBy: 'connectorType' },
  )

  assert.equal(summary.totalCost, 0)
  assert.equal(statements.length, 2)
  for (const statement of statements) {
    assert.match(statement, /metadata->>'productSlug' = 'deep-water'/)
    assert.match(statement, /metadata->>'source' = 'deep_water_run_update'/)
    assert.match(statement, /THEN 0\s+ELSE cost_amount/)
  }
})

test('product registry queries never read the local operational ledger', async () => {
  let query: unknown
  const prisma = {
    $queryRaw: async (statement: unknown) => {
      query = statement
      return []
    },
  } as unknown as PrismaClient

  await listIntegratedProducts(prisma, {
    organizationId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d401',
    teamId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d501',
    userId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d301',
  })

  const statement = ((query as { strings?: readonly string[] }).strings ?? []).join('?')
  assert.doesNotMatch(statement, /connector_usage_events/)
  assert.doesNotMatch(statement, /product_usage/)
})
