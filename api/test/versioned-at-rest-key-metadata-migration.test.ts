import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { Client } from 'pg'

const migrationSql = readFileSync(
  new URL(
    '../prisma/migrations/20260912090000_versioned_at_rest_key_metadata/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

const credentialTables = [
  'board_source_connection_credentials',
  'comms_connection_credentials',
  'mailbox_connection_credentials',
]

test('upgrades every legacy numeric credential metadata value to the legacy label', () => {
  for (const table of credentialTables) {
    assert.match(
      migrationSql,
      new RegExp(`ALTER TABLE "${table}"[\\s\\S]*TYPE TEXT USING "key_version"::TEXT`, 'u'),
    )
    assert.match(
      migrationSql,
      new RegExp(`UPDATE "${table}"[\\s\\S]*"key_version" = 'legacy'[\\s\\S]*"key_version" = '1'`, 'u'),
    )
  }
})


test('executes the upgrade over legacy integer metadata and normalizes every stored default', async () => {
  const databaseUrl = process.env.DATABASE_URL
  assert.ok(databaseUrl, 'DATABASE_URL is required for the migration upgrade-path test')
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const temporaryTables = new Map([
      ['board_source_connection_credentials', 'rotation_upgrade_board'],
      ['comms_connection_credentials', 'rotation_upgrade_comms'],
      ['mailbox_connection_credentials', 'rotation_upgrade_mailbox'],
    ])
    for (const table of temporaryTables.values()) {
      await client.query(`CREATE TEMP TABLE "${table}" (key_version INTEGER NOT NULL DEFAULT 1)`)
      await client.query(`INSERT INTO "${table}" DEFAULT VALUES`)
    }
    const upgradeSql = [...temporaryTables].reduce(
      (sql, [source, target]) => sql.replaceAll(`"${source}"`, `"${target}"`),
      migrationSql,
    )
    await client.query(upgradeSql)
    for (const table of temporaryTables.values()) {
      const row = await client.query<{ key_version: string; type: string }>(
        `SELECT key_version, pg_typeof(key_version)::text AS type FROM "${table}"`,
      )
      assert.deepEqual(row.rows, [{ key_version: 'legacy', type: 'text' }])
      const inserted = await client.query<{ key_version: string }>(
        `INSERT INTO "${table}" DEFAULT VALUES RETURNING key_version`,
      )
      assert.deepEqual(inserted.rows, [{ key_version: 'legacy' }])
    }
  } finally {
    await client.end()
  }
})
