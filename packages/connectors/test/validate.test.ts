import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ManifestValidationError,
} from '../src/errors.js'
import { parseManifest } from '../src/parse.js'
import {
  __canonicalJsonForHashing,
  validateManifest,
  validateManifestOrThrow,
} from '../src/validate.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const readFixture = (name: string): Promise<string> =>
  readFile(join(FIXTURES, name), 'utf8')

test('validateManifest accepts a well-formed bundle and reports absent signature', async () => {
  const value = parseManifest(await readFixture('valid.json'), 'json')

  const result = validateManifest(value)

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.signatureSupport, 'absent')
    assert.deepEqual(result.warnings, [])
    assert.equal(result.bundle.tools.length, 1)
  }
})

test('validateManifest rejects manifests missing a required field with field path', async () => {
  const value = parseManifest(await readFixture('missing-required.json'), 'json')

  const result = validateManifest(value)

  assert.equal(result.ok, false)
  if (!result.ok) {
    const paths = result.errors.map((e) => e.path)
    assert.ok(
      paths.some((p) => p.startsWith('tools.0.inputSchema')),
      `expected an error pointing at tools.0.inputSchema, got ${JSON.stringify(paths)}`,
    )
  }
})

test('validateManifest rejects unknown extra fields', async () => {
  const value = parseManifest(await readFixture('valid.json'), 'json') as Record<
    string,
    unknown
  >
  ;(value.metadata as Record<string, unknown>).rogueField = 'nope'

  const result = validateManifest(value)

  assert.equal(result.ok, false)
  if (!result.ok) {
    const paths = result.errors.map((e) => e.path)
    assert.ok(
      paths.some((p) => p.includes('metadata')),
      `expected error path under metadata, got ${JSON.stringify(paths)}`,
    )
  }
})

test('validateManifest verifies sha256 signatures over canonical-JSON', async () => {
  const value = parseManifest(await readFixture('valid.json'), 'json') as Record<
    string,
    unknown
  >
  const metadata = value.metadata as Record<string, unknown>
  const digest = createHash('sha256')
    .update(__canonicalJsonForHashing(value))
    .digest('hex')
  metadata.signature = { type: 'sha256', value: digest }

  const result = validateManifest(value)

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.signatureSupport, 'verified')
    assert.deepEqual(result.warnings, [])
  }
})

test('validateManifest rejects mismatched sha256 signatures', async () => {
  const value = parseManifest(await readFixture('valid.json'), 'json') as Record<
    string,
    unknown
  >
  const metadata = value.metadata as Record<string, unknown>
  metadata.signature = { type: 'sha256', value: 'a'.repeat(64) }

  const result = validateManifest(value)

  assert.equal(result.ok, false)
  if (!result.ok) {
    const paths = result.errors.map((e) => e.path)
    assert.ok(
      paths.includes('metadata.signature.value'),
      `expected metadata.signature.value error, got ${JSON.stringify(paths)}`,
    )
  }
})

test('validateManifest accepts ed25519 signatures with an unimplemented warning', async () => {
  const value = parseManifest(await readFixture('valid.json'), 'json') as Record<
    string,
    unknown
  >
  const metadata = value.metadata as Record<string, unknown>
  metadata.signature = { type: 'ed25519', value: 'not-yet-verified' }

  const result = validateManifest(value)

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.signatureSupport, 'unimplemented')
    assert.equal(result.warnings.length, 1)
    assert.equal(result.warnings[0]?.code, 'signatureUnimplemented')
  }
})

test('validateManifestOrThrow surfaces a ManifestValidationError on bad input', async () => {
  const value = parseManifest(await readFixture('missing-required.json'), 'json')

  try {
    validateManifestOrThrow(value)
    assert.fail('expected validateManifestOrThrow to throw')
  } catch (cause) {
    assert.ok(cause instanceof ManifestValidationError)
    assert.ok(cause.issues.length > 0)
  }
})
