import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../prisma/migrations/20260722020000_bind_uoa_session_identity/migration.sql',
  ),
  'utf8',
)
const productMigrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../prisma/migrations/20260722033000_nessie_account_link_product/migration.sql',
  ),
  'utf8',
)

test('product account links persist a nonnegative UOA token version', () => {
  assert.match(migrationSql, /ADD COLUMN "uoa_token_version" INTEGER/)
  assert.match(migrationSql, /"uoa_token_version" >= 0/)
})

test('refresh families store one encrypted immutable UOA session credential', () => {
  assert.match(migrationSql, /ADD COLUMN "replay_protected_until" TIMESTAMPTZ\(6\)/)
  assert.match(migrationSql, /CREATE TABLE "uoa_session_credentials"/)
  assert.match(migrationSql, /"family_id" UUID NOT NULL/)
  assert.match(migrationSql, /"subject" TEXT NOT NULL/)
  assert.match(migrationSql, /"organization_id" TEXT NOT NULL/)
  assert.match(migrationSql, /"team_id" TEXT NOT NULL/)
  assert.match(migrationSql, /"token_version" INTEGER NOT NULL/)
  assert.match(migrationSql, /"refresh_token_ciphertext" TEXT NOT NULL/)
  assert.match(migrationSql, /"refresh_token_auth_tag" TEXT NOT NULL/)
  assert.match(migrationSql, /"token_version" >= 0/)
  assert.match(migrationSql, /UNIQUE \("refresh_token_hash"\)/)
  assert.match(migrationSql, /UNIQUE \("last_local_token_id"\)/)
  assert.match(
    migrationSql,
    /FOREIGN KEY \("last_local_token_id"\) REFERENCES "refresh_tokens"\("id"\) ON DELETE CASCADE/,
  )
})

test('the stable Nessie UOA account link has a first-party product owner', () => {
  assert.match(productMigrationSql, /'nessie'/)
  assert.match(productMigrationSql, /'first-party\/nessie'/)
  assert.match(productMigrationSql, /'uoa_sso'/)
  assert.match(productMigrationSql, /ON CONFLICT \("slug"\) DO UPDATE/)
})
