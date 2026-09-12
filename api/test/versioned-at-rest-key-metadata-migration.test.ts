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

const redeployScript = readFileSync(
  new URL('../../infrastructure/compose/redeploy.sh', import.meta.url),
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

test('stages the incompatible metadata migration without old and new credential readers', () => {
  const preflight = redeployScript.indexOf('ensure-encryption-key-ring.sh infrastructure/compose/.env')
  const gate = redeployScript.indexOf("AT_REST_KEY_METADATA_MIGRATION='20260912090000_versioned_at_rest_key_metadata'")
  const migration = redeployScript.indexOf('==> Applying database migrations')
  assert.ok(preflight >= 0 && preflight < gate, 'preflight must succeed before any stop')
  assert.ok(gate >= 0 && gate < migration, 'the drain must run before migrations')
  assert.match(redeployScript, /\$COMPOSE stop nessie-api nessie-worker/u)
  assert.doesNotMatch(redeployScript, /\$COMPOSE stop nessie-api nessie-worker \|\| true/u)
  assert.match(redeployScript, /for legacy in api worker; do/u)
  assert.match(redeployScript, /for service in nessie-api nessie-worker api worker; do/u)
  assert.match(redeployScript, /API or worker containers remained running; refusing incompatible migration/u)
  assert.match(redeployScript, /legacy_service_containers worker/u)
  assert.match(redeployScript, /to_regclass\('_prisma_migrations'\)/u)
})
