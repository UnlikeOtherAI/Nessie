import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260919140000_resource_sharing_foundation/migration.sql',
)
const migrationSql = readFileSync(migrationPath, 'utf8')

test('resource share migration enforces exact scope and tenant ancestry', () => {
  assert.match(migrationSql, /CONSTRAINT "resource_shares_scope_board_chk"/)
  assert.match(migrationSql, /"target_board_id" IS NOT NULL/)
  assert.match(migrationSql, /"board_id" = "target_board_id"/)
  assert.match(migrationSql, /CONSTRAINT "resource_shares_distinct_organizations_chk"/)
  assert.match(migrationSql, /CONSTRAINT "resource_shares_project_fkey"[\s\S]*FOREIGN KEY \("project_id", "source_organization_id", "source_team_id"\)/)
  assert.match(migrationSql, /CONSTRAINT "resource_shares_board_fkey"[\s\S]*FOREIGN KEY \("board_id", "project_id", "source_organization_id"\)[\s\S]*ON DELETE SET NULL \("board_id"\)/)
})

test('resource share migration preserves immutable target and audience facts', () => {
  assert.match(migrationSql, /resource share target and audience are immutable/)
  for (const column of [
    'scope',
    'source_organization_id',
    'source_external_org_id',
    'source_team_id',
    'source_external_team_id',
    'project_id',
    'target_board_id',
    'recipient_organization_id',
    'recipient_external_org_id',
    'recipient_team_id',
    'recipient_external_team_id',
  ]) {
    assert.match(migrationSql, new RegExp(`NEW\\."${column}"`))
    assert.match(migrationSql, new RegExp(`OLD\\."${column}"`))
  }
})

test('resource share migration gives project and board scopes separate live uniqueness', () => {
  assert.match(migrationSql, /CREATE UNIQUE INDEX "resource_shares_live_project_recipient_key"/)
  assert.match(migrationSql, /WHERE "scope" = 'project' AND "status" IN \('pending', 'active'\)/)
  assert.match(migrationSql, /CREATE UNIQUE INDEX "resource_shares_live_board_recipient_key"/)
  assert.match(migrationSql, /WHERE "scope" = 'board' AND "status" IN \('pending', 'active'\)/)
})

test('every board publication edge mutation advances the durable revision', () => {
  assert.match(migrationSql, /CREATE FUNCTION "bump_board_share_publication_revision"/)
  for (const table of [
    'board_shared_fields',
    'board_shared_iterations',
    'board_shared_resources',
  ]) {
    assert.match(
      migrationSql,
      new RegExp(
        `CREATE TRIGGER "${table}_bump_publication_revision_trg"` +
        `[\\s\\S]*AFTER INSERT OR UPDATE OR DELETE ON "${table}"`,
      ),
    )
  }
  assert.match(migrationSql, /SET "revision" = "revision" \+ 1/)
  assert.match(migrationSql, /IF NEW\."board_id" <> OLD\."board_id" THEN/)
})
