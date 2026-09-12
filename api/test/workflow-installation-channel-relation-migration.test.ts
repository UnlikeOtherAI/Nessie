import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../prisma/migrations/20260912100000_workflow_installation_channel_relation/migration.sql',
  ),
  'utf8',
)

test('the installation channel FK detaches legacy invalid scopes before it is added', () => {
  assert.match(
    migrationSql,
    /UPDATE "workflow_installations" AS installation[\s\S]*SET "channel_id" = NULL[\s\S]*FROM "channels" AS channel[\s\S]*channel\."id" = installation\."channel_id"[\s\S]*channel\."organization_id" = installation\."organization_id"/,
  )
  assert.ok(
    migrationSql.indexOf('SET "channel_id" = NULL')
      < migrationSql.indexOf('ADD CONSTRAINT "workflow_installations_channel_id_fkey"'),
  )
})
