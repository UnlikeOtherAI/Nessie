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

// Pool sizing had no env mapping at all: only `nessie.config.json` could move
// it, so a containerised deployment was pinned to 10/2 and the per-replica
// connection ceiling could not be tuned as replicas were added.
test('NESSIE_DB_POOL_MAX and NESSIE_DB_POOL_MIN override the pool defaults', () => {
  const config = load({ NESSIE_DB_POOL_MAX: '4', NESSIE_DB_POOL_MIN: '1' })

  assert.equal(config.database.poolMax, 4)
  assert.equal(config.database.poolMin, 1)
})

test('pool sizing falls back to the 10/2 defaults when unset', () => {
  const config = load({})

  assert.equal(config.database.poolMax, 10)
  assert.equal(config.database.poolMin, 2)
})

test('NESSIE_SHUTDOWN_TIMEOUT_MS overrides the drain deadline, default 25000', () => {
  assert.equal(load({}).shutdownTimeoutMs, 25_000)
  assert.equal(load({ NESSIE_SHUTDOWN_TIMEOUT_MS: '8000' }).shutdownTimeoutMs, 8_000)
})

// Cloud Run, Heroku and Fly inject `PORT` and nothing else, so the API must
// bind it — but an operator who pinned `NESSIE_API_PORT` (production pins the
// container's internal 5554) must keep winning over whatever the platform set.
test('PORT feeds api.port when NESSIE_API_PORT is absent', () => {
  const config = load({ PORT: '8080' })

  assert.equal(config.api.port, 8080)
})

test('NESSIE_API_PORT wins over PORT', () => {
  const config = load({ PORT: '8080', NESSIE_API_PORT: '5554' })

  assert.equal(config.api.port, 5554)
})

test('an emptied NESSIE_API_PORT falls back to PORT', () => {
  const config = load({ PORT: '8080', NESSIE_API_PORT: '' })

  assert.equal(config.api.port, 8080)
})

test('neither PORT nor NESSIE_API_PORT leaves the 5454 default', () => {
  const config = load({})

  assert.equal(config.api.port, 5454)
})

// Plan row 4.12 / audit 7.7. `'pubsub'` outlived its provider: the adapter, the
// worker's fallback branch and the terraform module are all deleted, so a
// deployment configured for it used to boot silently on Postgres. The enum now
// has one member, and naming the retired one is a startup error.
test('NESSIE_QUEUE_PROVIDER=pubsub is rejected rather than silently accepted', () => {
  assert.throws(
    () => load({ NESSIE_QUEUE_PROVIDER: 'pubsub' }),
    /queue/i,
  )
})

test('NESSIE_QUEUE_PROVIDER=local still loads', () => {
  assert.equal(load({ NESSIE_QUEUE_PROVIDER: 'local' }).queue.provider, 'local')
})
