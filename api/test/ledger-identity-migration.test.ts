import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../prisma/migrations/20260718190000_ledger_identity_attribution/migration.sql',
  ),
  'utf8',
)

test('adds first-class effective-user attribution to both local usage ledgers', () => {
  assert.match(migrationSql, /ALTER TABLE "token_ledger_events"\s+ADD COLUMN "user_id" uuid/)
  assert.match(migrationSql, /ALTER TABLE "connector_usage_events"\s+ADD COLUMN "user_id" uuid/)
  assert.match(
    migrationSql,
    /token_ledger_events_organization_id_user_id_occurred_at_idx/,
  )
  assert.match(
    migrationSql,
    /connector_usage_events_organization_id_user_id_occurred_at_idx/,
  )
})

test('moves managed DeepWater instances to the shared Ledger service token', () => {
  assert.match(migrationSql, /DELETE FROM "mcp_server_credential_overrides"/)
  assert.match(migrationSql, /"credential_ref" = 'LEDGER_PROXY_TOKEN'/)
  assert.match(migrationSql, /signed Nessie and UOA headers/)
  assert.match(migrationSql, /"catalog"\."visibility" = 'public'/)
  assert.match(
    migrationSql,
    /"product"\."mcp_catalog_entry_id" = "catalog"\."id"/,
  )
})

test('keeps DeepWater product identity on UOA SSO independently of transport auth', () => {
  assert.match(
    migrationSql,
    /"auth_mode"\s*=\s*'uoa_sso'::"IntegratedProductAuthMode"/,
  )
  assert.match(migrationSql, /"credential_ref" = 'LEDGER_PROXY_TOKEN'/)
})

test('deletes only unshared encrypted DeepWater override secrets', () => {
  assert.match(migrationSql, /DELETE FROM "mcp_oauth_secret"/)
  assert.match(
    migrationSql,
    /"other_instance"\."id" NOT IN \(SELECT "id" FROM "deep_water_instances"\)/,
  )
  assert.match(
    migrationSql,
    /"other_override"\."instance_id" NOT IN \(SELECT "id" FROM "deep_water_instances"\)/,
  )
  assert.ok(
    migrationSql.indexOf('DELETE FROM "mcp_oauth_secret"')
      < migrationSql.indexOf('DELETE FROM "mcp_server_credential_overrides"'),
  )
})
