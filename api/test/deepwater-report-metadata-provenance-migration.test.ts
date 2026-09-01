import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migrationSql = readFileSync(
  new URL(
    '../prisma/migrations/20260720150000_deepwater_report_metadata_provenance/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

test('legacy DeepWater usage units require authenticated report provenance', () => {
  assert.match(migrationSql, /UPDATE "connector_usage_events"/)
  assert.match(migrationSql, /FROM "product_integration_runs"/)
  assert.match(migrationSql, /sourceCountSource/)
  assert.match(migrationSql, /ledger_research_report/)
  assert.match(migrationSql, /'deep-water:' \|\| run\."id"::text/)
  assert.match(migrationSql, /ELSE NULL/)
})
