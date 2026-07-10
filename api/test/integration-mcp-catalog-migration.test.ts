import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260708161000_first_party_mcp_catalog_entries/migration.sql',
)

const migrationSql = readFileSync(migrationPath, 'utf8')

test('first-party MCP-backed products are seeded into the public catalog', () => {
  assert.match(migrationSql, /'deep-water'/)
  assert.match(migrationSql, /'deeptest'/)
  assert.match(migrationSql, /'oauth2'::"McpCatalogAuthMethod"/)
  assert.match(migrationSql, /'none'::"McpCatalogAuthMethod"/)
  assert.match(migrationSql, /'published'::"McpCatalogStatus"/)
  assert.match(migrationSql, /'public'::"McpCatalogVisibility"/)
})

test('product registry rows are linked to their MCP catalog entries', () => {
  assert.match(migrationSql, /UPDATE "integrated_products" "product"/)
  assert.match(migrationSql, /"mcp_catalog_entry_id" = "catalog"\."id"/)
  assert.match(
    migrationSql,
    /"catalog"\."name" IN \('deep-water', 'deeptest'\)/,
  )
})

test('catalog setup metadata does not hard-code placeholder MCP URLs', () => {
  assert.doesNotMatch(migrationSql, /https:\/\/deep-water\.example/)
  assert.doesNotMatch(migrationSql, /http:\/\/127\.0\.0\.1:4877/)
  assert.match(migrationSql, /'DEEP_WATER_MCP_URL'/)
  assert.match(migrationSql, /'DEEPTEST_MCP_URL'/)
})
