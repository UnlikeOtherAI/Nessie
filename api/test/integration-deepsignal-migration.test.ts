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

test('the DeepSignal product row is seeded idempotently', () => {
  assert.match(productSql, /INSERT INTO "integrated_products"/)
  assert.match(productSql, /'deepsignal'/)
  assert.match(productSql, /'DeepSignal'/)
  assert.match(productSql, /'oauth_mcp'/)
  assert.match(productSql, /ON CONFLICT \("slug"\) DO UPDATE SET/)
})

test('the DeepSignal MCP catalog entry is first-party, public, dynamic OAuth', () => {
  assert.match(productSql, /'http'::"McpCatalogProtocol"/)
  assert.match(productSql, /'oauth2'::"McpCatalogAuthMethod"/)
  assert.match(productSql, /'published'::"McpCatalogStatus"/)
  assert.match(productSql, /'public'::"McpCatalogVisibility"/)
  assert.match(productSql, /https:\/\/api\.deepsignal\.live\/mcp/)
  // Dynamic OAuth: method only, no static client id/secret in authConfig.
  assert.match(productSql, /jsonb_build_object\('method', 'oauth2'\)/)
  assert.doesNotMatch(productSql, /clientId/)
})

test('the product row is back-linked to its catalog entry', () => {
  assert.match(productSql, /UPDATE "integrated_products" "product"/)
  assert.match(productSql, /"mcp_catalog_entry_id" = "catalog"\."id"/)
  assert.match(productSql, /"catalog"\."name" = 'deepsignal'/)
})
