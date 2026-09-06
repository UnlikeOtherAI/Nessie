import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  assertLocalOnlyCapability,
  DOCKER_EXECUTION_PROVIDER,
  FILESYSTEM_BUILTIN_TOOLS,
  loadConfig,
  localOnlyCapabilityMessage,
  SingleInstanceCapabilityError,
} from '../src/index.js'

// Invariant 7, docs/standards/horizontal-scaling.md: three capabilities only
// work while one process owns the machine's disk. `filesystem` storage is the
// one that is configuration, so `loadConfig` is where it is refused; the other
// two are per-organisation database rows, refused at their worker chokepoints,
// and only their refusal wording is pinned here.

// loadConfig reads `nessie.config.json` from cwd. Point every case at an empty
// directory so the developer's own config file cannot colour the result.
const EMPTY_DIR = mkdtempSync(`${tmpdir()}/nessie-local-only-`)

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

// `assert.throws` returns void, and every case here asserts on the wording of
// the refusal, not merely that one happened.
const refusalFrom = (fn: () => unknown): Error => {
  try {
    fn()
  } catch (error) {
    assert.ok(
      error instanceof SingleInstanceCapabilityError,
      `expected a SingleInstanceCapabilityError, got ${String(error)}`,
    )
    return error
  }
  throw new Error('expected a refusal; the call succeeded')
}

const S3 = {
  NESSIE_STORAGE_PROVIDER: 's3',
  NESSIE_STORAGE_BUCKET: 'nessie',
  NESSIE_STORAGE_ENDPOINT: 'http://nessie-minio:9000',
}

for (const mode of ['selfHosted', 'hosted'] as const) {
  test(`filesystem storage is refused in ${mode} mode, naming the setting and the fix`, () => {
    const error = refusalFrom(
      () => load({ NESSIE_MODE: mode, NESSIE_STORAGE_PROVIDER: 'filesystem' }),
    )

    assert.match(error.message, /NESSIE_STORAGE_PROVIDER=filesystem/)
    assert.match(error.message, new RegExp(`not allowed in ${mode} mode`))
    assert.match(error.message, /Set NESSIE_STORAGE_PROVIDER=s3/)
    // "and credentials" is not an instruction. Name the variables.
    assert.match(error.message, /NESSIE_STORAGE_ACCESS_KEY_ID/)
    assert.match(error.message, /NESSIE_STORAGE_SECRET_ACCESS_KEY/)
  })

  test(`filesystem storage is refused in ${mode} mode when nothing sets a provider`, () => {
    // The whole point of 1.10: `filesystem` is the DEFAULT, so a deployment
    // that simply forgets the variable is the case that must fail.
    refusalFrom(() => load({ NESSIE_MODE: mode }))
  })

  test(`s3 storage loads normally in ${mode} mode`, () => {
    const config = load({ NESSIE_MODE: mode, ...S3 })

    assert.equal(config.storage.provider, 's3')
    assert.equal(config.mode, mode)
  })
}

test('local mode keeps filesystem storage, defaulted and explicit', () => {
  assert.equal(load({ NESSIE_MODE: 'local' }).storage.provider, 'filesystem')
  assert.equal(
    load({ NESSIE_MODE: 'local', NESSIE_STORAGE_PROVIDER: 'filesystem' }).storage.provider,
    'filesystem',
  )
})

test('the docker execution provider is refused outside local, and points at gcloud', () => {
  const error = refusalFrom(
    () => assertLocalOnlyCapability('selfHosted', DOCKER_EXECUTION_PROVIDER),
  )

  assert.match(error.message, /`docker` execution environment provider/)
  assert.match(error.message, /not allowed in selfHosted mode/)
  assert.match(error.message, /provider `gcloud`/)
  // `gcloud` alone asks a self-hosted operator to go and buy cloud
  // infrastructure. The message also has to say what to do about the containers
  // they already have, which is why terminate is not gated.
  assert.match(error.message, /terminating an existing one never is/)
})

test('the file_* builtins are refused outside local, and say what to use instead', () => {
  const error = refusalFrom(
    () => assertLocalOnlyCapability('hosted', FILESYSTEM_BUILTIN_TOOLS),
  )

  assert.match(error.message, /`file_read`, `file_write` and `file_glob`/)
  assert.match(error.message, /not allowed in hosted mode/)
  assert.match(error.message, /knowledge base or an MCP server/)
})

test('every local-only capability stays legal in local mode', () => {
  for (const capability of [DOCKER_EXECUTION_PROVIDER, FILESYSTEM_BUILTIN_TOOLS]) {
    assert.doesNotThrow(() => assertLocalOnlyCapability('local', capability))
  }
})

test('the message a non-throwing caller reports is the one a refusal would print', () => {
  // The execution-runner probe records a reason instead of throwing; the two
  // must not drift apart.
  const message = localOnlyCapabilityMessage('selfHosted', DOCKER_EXECUTION_PROVIDER)
  const thrown = refusalFrom(
    () => assertLocalOnlyCapability('selfHosted', DOCKER_EXECUTION_PROVIDER),
  )

  assert.equal(thrown.message, message)
})
