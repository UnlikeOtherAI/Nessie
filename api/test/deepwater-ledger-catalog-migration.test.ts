import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260718120000_deepwater_via_ledger_mcp/migration.sql',
)

const migrationSql = readFileSync(migrationPath, 'utf8')
const retirementSql = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260720234500_retire_deepwater_local_cost_mirror/migration.sql',
), 'utf8')

test('DeepWater catalog is migrated to the Ledger bearer MCP adapter', () => {
  assert.match(migrationSql, /'bearer'::"McpCatalogAuthMethod"/)
  assert.match(migrationSql, /jsonb_build_object\('method', 'bearer'\)/)
  assert.match(migrationSql, /'LEDGER_DEEPWATER_MCP_URL'/)
  assert.doesNotMatch(migrationSql, /'DEEP_WATER_MCP_URL'/)
  assert.doesNotMatch(migrationSql, /api\.deepwater\.live/)
})

test('DeepWater product setup no longer advertises direct OAuth', () => {
  assert.match(migrationSql, /UPDATE "integrated_products"/)
  assert.match(migrationSql, /"auth_mode" = 'api_key'::"IntegratedProductAuthMode"/)
  assert.match(retirementSql, /Customer totals come only from UOA/)
})

test('legacy direct instances fail closed until the team is re-enabled', () => {
  assert.match(migrationSql, /"status" = 'disabled'::"ToolRegistryEntryStatus"/)
  assert.match(migrationSql, /DELETE FROM "mcp_oauth_secret"/)
  assert.match(migrationSql, /"other_instance"\."credential_ref" = "owned"\."ref"/)
  assert.match(migrationSql, /"other_override"\."credential_ref" = "owned"\."ref"/)
  assert.match(migrationSql, /DELETE FROM "mcp_server_credential_overrides"/)
  assert.match(migrationSql, /"credential_ref" = NULL/)
  assert.match(migrationSql, /"transport_config" = '\{\}'::jsonb/)
  assert.match(migrationSql, /"lifecycle_state" = 'pending_setup'::"McpServerLifecycleState"/)
  assert.match(migrationSql, /UPDATE "product_team_enablements"/)
  assert.match(migrationSql, /"enabled" = false/)
  assert.ok(
    migrationSql.indexOf('DELETE FROM "mcp_oauth_secret"')
      < migrationSql.indexOf('DELETE FROM "mcp_server_credential_overrides"'),
  )
})

test('destructive cleanup is limited to the public catalog linked to the first-party product', () => {
  const productCatalogJoin =
    /"product"\."mcp_catalog_entry_id" = "catalog"\."id"/g
  const publicCatalogGuard =
    /"catalog"\."visibility" = 'public'/g

  // Tool disabling, secret cleanup, override cleanup, instance reset, and team
  // disabling each independently prove the target catalog is the one linked by
  // integrated_products. A private user-authored `deep-water` entry therefore
  // cannot be selected by name alone.
  assert.equal(migrationSql.match(productCatalogJoin)?.length, 5)
  assert.equal(migrationSql.match(publicCatalogGuard)?.length, 6)
  assert.match(
    migrationSql,
    /JOIN "integrated_products" "product"\s+ON "product"\."mcp_catalog_entry_id" = "catalog"\."id"\s+AND "product"\."slug" = 'deep-water'/,
  )
  assert.match(
    migrationSql,
    /UPDATE "product_team_enablements"[\s\S]*AND EXISTS \([\s\S]*"catalog"\."visibility" = 'public'/,
  )
})
