import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { loadConfig } from '../src/index.js'

// loadConfig reads `nessie.config.json` from cwd. Point every case at an empty
// directory so the developer's own config file cannot colour the result.
const EMPTY_DIR = mkdtempSync(`${tmpdir()}/nessie-env-overrides-`)

const load = (env: NodeJS.ProcessEnv) =>
  loadConfig({
    argv: [],
    cwd: EMPTY_DIR,
    env: {
      NESSIE_AUTH_SECRET: 'a'.repeat(64),
      NESSIE_DB_URL: 'postgresql://nessie:nessie@127.0.0.1:5432/nessie',
      ...env,
    },
  })

// `DATABASE_URL= pnpm test` is the documented way to skip database suites in a
// run: the variable is present but empty, and only `undefined` marks a shell
// variable unset. An empty string must mean "no override", never a
// schema-crashing empty `database.url`.
test('an emptied DATABASE_URL falls back to NESSIE_DB_URL instead of overriding with ""', () => {
  const config = load({ DATABASE_URL: '' })

  assert.equal(config.database.url, 'postgresql://nessie:nessie@127.0.0.1:5432/nessie')
})

test('an emptied NESSIE_DB_URL falls back to DATABASE_URL', () => {
  const config = load({
    NESSIE_DB_URL: '',
    DATABASE_URL: 'postgresql://nessie:nessie@127.0.0.1:5432/other',
  })

  assert.equal(config.database.url, 'postgresql://nessie:nessie@127.0.0.1:5432/other')
})

test('DATABASE_URL feeds database.url when NESSIE_DB_URL is absent', () => {
  const config = loadConfig({
    argv: [],
    cwd: EMPTY_DIR,
    env: {
      NESSIE_AUTH_SECRET: 'a'.repeat(64),
      DATABASE_URL: 'postgresql://nessie:nessie@127.0.0.1:5432/override',
    },
  })

  assert.equal(config.database.url, 'postgresql://nessie:nessie@127.0.0.1:5432/override')
})

test('an emptied mapped variable is skipped rather than written as ""', () => {
  const config = load({ NESSIE_MODEL_PROVIDER: '' })

  assert.notEqual(config.model.provider, '')
})
