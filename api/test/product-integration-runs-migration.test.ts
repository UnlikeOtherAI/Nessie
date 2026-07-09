import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260710103000_product_integration_runs/migration.sql',
)

const migrationSql = readFileSync(migrationPath, 'utf8')

test('product integration runs migration creates the durable run table', () => {
  assert.match(migrationSql, /CREATE TYPE "ProductIntegrationRunStatus" AS ENUM/)
  assert.match(migrationSql, /'queued'/)
  assert.match(migrationSql, /'running'/)
  assert.match(migrationSql, /'completed'/)
  assert.match(migrationSql, /CREATE TABLE "product_integration_runs"/)
  assert.match(migrationSql, /"input_json" JSONB NOT NULL DEFAULT '\{\}'::JSONB/)
  assert.match(migrationSql, /"result_json" JSONB NOT NULL DEFAULT '\{\}'::JSONB/)
  assert.match(migrationSql, /"cost_amount" DECIMAL\(18, 6\)/)
})

test('product integration runs migration scopes history and external ids', () => {
  assert.match(migrationSql, /product_integration_runs_scope_requested_idx/)
  assert.match(
    migrationSql,
    /"organization_id", "team_id", "product_slug", "requested_at" DESC/,
  )
  assert.match(migrationSql, /product_integration_runs_status_idx/)
  assert.match(migrationSql, /product_integration_runs_org_product_external_run_key/)
  assert.match(migrationSql, /WHERE "external_run_id" IS NOT NULL/)
})

test('product integration runs migration preserves product boundaries', () => {
  assert.match(migrationSql, /REFERENCES "organizations"\("id"\)[\s\S]*ON DELETE CASCADE/)
  assert.match(migrationSql, /REFERENCES "teams"\("id"\)[\s\S]*ON DELETE CASCADE/)
  assert.match(migrationSql, /REFERENCES "integrated_products"\("slug"\)[\s\S]*ON DELETE CASCADE/)
  assert.match(migrationSql, /REFERENCES "mcp_server_instances"\("id"\)[\s\S]*ON DELETE SET NULL/)
  assert.match(migrationSql, /REFERENCES "knowledge_pages"\("id"\)[\s\S]*ON DELETE SET NULL/)
})
