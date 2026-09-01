import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations',
)

const productSql = readFileSync(
  resolve(migrationDir, '20260709121000_deepsignal_product/migration.sql'),
  'utf8',
)
const appKeyBoundarySql = readFileSync(
  resolve(
    migrationDir,
    '20260719190000_deepsignal_app_api_key_boundary/migration.sql',
  ),
  'utf8',
)
const enumSql = readFileSync(
  resolve(migrationDir, '20260709120000_agent_execution_mode_external_agent/migration.sql'),
  'utf8',
)

test('the schema migration adds the execution mode enum + column and channel type', () => {
  assert.match(enumSql, /CREATE TYPE "AgentExecutionMode" AS ENUM/)
  assert.match(enumSql, /'inference'/)
  assert.match(enumSql, /'external_mcp'/)
  assert.match(enumSql, /ADD COLUMN "execution_mode" "AgentExecutionMode" NOT NULL DEFAULT 'inference'/)
  assert.match(enumSql, /ALTER TYPE "ChannelSystemType" ADD VALUE IF NOT EXISTS 'external_agent'/)
})

test('the historical DeepSignal product seed remains idempotent', () => {
  assert.match(productSql, /INSERT INTO "integrated_products"/)
  assert.match(productSql, /'deepsignal'/)
  assert.match(productSql, /'DeepSignal'/)
  assert.match(productSql, /'oauth_mcp'/)
  assert.match(productSql, /ON CONFLICT \("slug"\) DO UPDATE SET/)
})

test('the original DeepSignal catalog entry remains first-party and public', () => {
  assert.match(productSql, /'http'::"McpCatalogProtocol"/)
  assert.match(productSql, /'oauth2'::"McpCatalogAuthMethod"/)
  assert.match(productSql, /'published'::"McpCatalogStatus"/)
  assert.match(productSql, /'public'::"McpCatalogVisibility"/)
  assert.match(productSql, /https:\/\/api\.deepsignal\.live\/mcp/)
})

test('the product row is back-linked to its catalog entry', () => {
  assert.match(productSql, /UPDATE "integrated_products" "product"/)
  assert.match(productSql, /"mcp_catalog_entry_id" = "catalog"\."id"/)
  assert.match(productSql, /"catalog"\."name" = 'deepsignal'/)
})

test('the app-key boundary replaces OAuth without storing the plaintext key', () => {
  assert.match(appKeyBoundarySql, /"auth_method" = 'bearer'/)
  assert.match(
    appKeyBoundarySql,
    /"auth_config" = jsonb_build_object\('method', 'bearer'\)/,
  )
  assert.match(appKeyBoundarySql, /https:\/\/api\.deepsignal\.live\/mcp/)
  assert.match(appKeyBoundarySql, /"auth_mode" = 'uoa_sso'/)
  assert.match(
    appKeyBoundarySql,
    /"credential_ref" = 'DEEPSIGNAL_MCP_APP_KEY'/,
  )
  assert.doesNotMatch(appKeyBoundarySql, /dsk_[A-Za-z0-9_-]+/)
})

test('the app-key migration removes every per-user OAuth shadow path', () => {
  assert.match(appKeyBoundarySql, /DELETE FROM "mcp_oauth_secret"/)
  assert.match(appKeyBoundarySql, /DELETE FROM "mcp_oauth_states"/)
  assert.match(
    appKeyBoundarySql,
    /DELETE FROM "mcp_server_credential_overrides"/,
  )
  assert.match(appKeyBoundarySql, /DELETE FROM "tool_registry_entries"/)
  assert.match(
    appKeyBoundarySql,
    /"status" = 'needs_auth'.*"uoa_sub" IS NOT NULL.*"active_org_id" IS NOT NULL.*"active_team_id" IS NOT NULL/s,
  )
})
