import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { ConnectorUsageMetadataSchema } from '@nessie/runtime'

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
    // One predicate, on the field the single write door stamps — not a chain of
    // spellings each writer might or might not have used.
    assert.match(
      statement,
      /CASE WHEN metadata->>'metering' = 'operational_only' THEN 0 ELSE cost_amount END/,
    )
    for (const retiredSpelling of [
      /metadata->>'productSlug'/,
      /metadata->>'product_slug'/,
      /metadata->>'product'/,
      /metadata->>'source'/,
    ]) {
      assert.doesNotMatch(statement, retiredSpelling)
    }
  }
})

test('DeepWater usage is written with the metering flag the cost report reads', async () => {
  const metadata = ConnectorUsageMetadataSchema.parse({
    metering: 'operational_only',
    productSlug: 'deep-water',
    source: 'deep_water_run_update',
  })

  assert.equal(metadata.metering, 'operational_only')
  // Provenance keys are not governed, and are not dropped either.
  assert.equal(metadata.source, 'deep_water_run_update')
})

test('an event with no metering of its own is recorded as billable', () => {
  assert.equal(ConnectorUsageMetadataSchema.parse({}).metering, 'billable')
  assert.throws(() => ConnectorUsageMetadataSchema.parse({ metering: 'free' }))
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
