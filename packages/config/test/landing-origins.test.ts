import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { loadConfig, OriginAllowlistError, parseOriginAllowlist } from '../src/index.js'

// loadConfig reads `nessie.config.json` from cwd; an empty directory keeps the
// developer's own file out of the result.
const EMPTY_DIR = mkdtempSync(`${tmpdir()}/nessie-landing-origins-`)

const load = (env: NodeJS.ProcessEnv, cwd = EMPTY_DIR) =>
  loadConfig({
    argv: [],
    cwd,
    env: {
      NESSIE_AUTH_SECRET: 'a'.repeat(64),
      NESSIE_DB_URL: 'postgresql://nessie:nessie@127.0.0.1:5432/nessie',
      ...env,
    },
  })

test('NESSIE_LANDING_ORIGIN unset: no landing origins', () => {
  assert.deepEqual(load({}).api.landingOrigins, [])
})

test('NESSIE_LANDING_ORIGIN is a trimmed, empty-dropping, origin-normalised list', () => {
  const config = load({
    NESSIE_LANDING_ORIGIN: ' https://nessie.works , ,https://WWW.nessie.works/,https://nessie.works:443,http://localhost:3000,',
  })
  assert.deepEqual(config.api.landingOrigins, [
    'https://nessie.works',
    'https://www.nessie.works',
    'http://localhost:3000',
  ])
})

test('an empty NESSIE_LANDING_ORIGIN admits nothing', () => {
  assert.deepEqual(load({ NESSIE_LANDING_ORIGIN: ' , ' }).api.landingOrigins, [])
})

test('a malformed entry, path, query, fragment, credentials or non-http scheme refuses to load', () => {
  const invalid = [
    'nessie.works',
    'https://',
    'https://nessie.works/landing',
    'https://nessie.works/?x=1',
    'https://nessie.works#top',
    'https://user:pass@nessie.works',
    'ftp://nessie.works',
    'javascript:alert(1)',
    '*',
    'null',
  ]
  for (const entry of invalid) {
    assert.throws(
      () => load({ NESSIE_LANDING_ORIGIN: `https://nessie.works,${entry}` }),
      (error: unknown) => error instanceof OriginAllowlistError && error.message.includes('NESSIE_LANDING_ORIGIN'),
      entry,
    )
  }
})

test('parseOriginAllowlist names its source in the error', () => {
  assert.throws(() => parseOriginAllowlist('https://a.test/path', 'SOME_VAR'), /SOME_VAR: "https:\/\/a\.test\/path"/)
})

test('config-file landing origins must already be bare origins', () => {
  const dir = mkdtempSync(`${tmpdir()}/nessie-landing-origins-file-`)
  writeFileSync(`${dir}/nessie.config.json`, JSON.stringify({ api: { landingOrigins: ['https://nessie.works'] } }))
  assert.deepEqual(load({}, dir).api.landingOrigins, ['https://nessie.works'])

  writeFileSync(`${dir}/nessie.config.json`, JSON.stringify({ api: { landingOrigins: ['https://nessie.works/x'] } }))
  assert.throws(() => load({}, dir), /bare http\(s\) origin/)
})
