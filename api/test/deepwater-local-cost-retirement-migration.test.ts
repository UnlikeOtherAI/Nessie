import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260720234500_retire_deepwater_local_cost_mirror/migration.sql',
)

const migrationSql = readFileSync(migrationPath, 'utf8')

test('DeepWater historical local amounts are erased without losing dispatch safety', () => {
  assert.match(migrationSql, /jsonb_build_object\('legacyDispatchEvidence', true\)/)
  assert.match(migrationSql, /UPDATE "product_integration_runs"[\s\S]*"cost_amount" = NULL/)
  assert.match(migrationSql, /UPDATE "connector_usage_events"[\s\S]*"cost_amount" = NULL/)
  assert.match(migrationSql, /"cost_currency" = NULL/g)
  assert.match(
    migrationSql,
    /ALTER TABLE "product_integration_runs"[\s\S]*DROP COLUMN "cost_amount"[\s\S]*DROP COLUMN "cost_currency"/,
  )
})

test('schema and database guard reject any new DeepWater local cost persistence', () => {
  assert.match(migrationSql, /CREATE TRIGGER "connector_usage_events_deepwater_cost_boundary"/)
  assert.match(migrationSql, /DeepWater connector cost persistence is forbidden/)
  assert.match(migrationSql, /UOA is authoritative/)
})

test('DeepWater product copy points customer totals to UOA', () => {
  assert.match(migrationSql, /Customer totals come only from UOA/)
  assert.match(migrationSql, /'raw_usage'/)
  assert.doesNotMatch(
    migrationSql,
    /"capabilities"[^;]*'usage_cost'/,
  )
  assert.match(migrationSql, /UOA supplies customer totals/)
})
