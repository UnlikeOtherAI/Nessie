import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../prisma/migrations/20260719143000_deepwater_app_api_key_boundary/migration.sql',
  ),
  'utf8',
)

test('clarifies that the Ledger bearer is Nessie\'s product-bound app API key', () => {
  assert.match(migrationSql, /Nessie''s dedicated Ledger app API key/)
  assert.match(migrationSql, /product-bound Ledger app API key in LEDGER_PROXY_TOKEN/)
  assert.match(migrationSql, /Signed SSO (caller )?identity/)
  assert.match(migrationSql, /webhook signing secrets (as this key|stay separate)/)
})

test('updates only the linked public DeepWater catalog copy', () => {
  assert.match(
    migrationSql,
    /"product"\."mcp_catalog_entry_id"[\s\S]*"product"\."slug" = 'deep-water'/,
  )
  assert.match(migrationSql, /"catalog"\."name" = 'deep-water'/)
  assert.match(migrationSql, /"catalog"\."visibility" = 'public'/)
  assert.match(migrationSql, /UPDATE "integrated_products"/)
  assert.doesNotMatch(migrationSql, /"credential_ref"\s*=/)
  assert.doesNotMatch(migrationSql, /"auth_mode"\s*=/)
})

test('preserves the existing transport object while replacing setup text', () => {
  assert.match(migrationSql, /jsonb_set\(/)
  assert.match(migrationSql, /COALESCE\("catalog"\."default_transport_config"/)
  assert.doesNotMatch(migrationSql, /jsonb_build_object\(/)
})
