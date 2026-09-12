import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const preflight = fileURLToPath(new URL(
  '../../infrastructure/compose/ensure-encryption-key-ring.sh',
  import.meta.url,
))

const withEnvFile = (contents: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'nessie-encryption-preflight-'))
  const envFile = join(directory, '.env')
  writeFileSync(envFile, contents)
  return { directory, envFile }
}

const bashPath = (path: string): string => path
  .replace(/^([A-Za-z]):/u, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
  .replaceAll('\\', '/')

const runPreflight = (envFile: string) => spawnSync('bash', [bashPath(preflight), bashPath(envFile)], {
  encoding: 'utf8',
})

test('deployment preflight stages a separate ring and retains the former root without logging it', () => {
  const authSecret = 'auth-signing-root-must-never-be-printed'
  const { envFile } = withEnvFile(`NESSIE_AUTH_SECRET=${authSecret}\n`)

  const result = runPreflight(envFile)

  assert.equal(result.status, 0, result.stderr)
  const staged = readFileSync(envFile, 'utf8')
  assert.match(staged, /NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION=bootstrap-2026-09/u)
  assert.match(staged, /NESSIE_ENCRYPTION_KEY_RING=\{"bootstrap-2026-09":"[a-f0-9]{64}"\}/u)
  assert.match(staged, new RegExp(`NESSIE_ENCRYPTION_LEGACY_KEY=${authSecret}`, 'u'))
  assert.doesNotMatch(result.stdout, new RegExp(authSecret, 'u'))
  assert.doesNotMatch(result.stderr, new RegExp(authSecret, 'u'))
})

test('deployment preflight rejects a partial ring before a migration or rollout can start', () => {
  const { envFile } = withEnvFile('NESSIE_ENCRYPTION_KEY_RING={"2026-09":"root"}\n')

  const result = runPreflight(envFile)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ACTIVE_KEY_VERSION/u)
})

test('deployment preflight preserves an operator-configured active ring', () => {
  const contents = [
    'NESSIE_AUTH_SECRET=auth-root',
    'NESSIE_ENCRYPTION_ACTIVE_KEY_VERSION=2026-09',
    'NESSIE_ENCRYPTION_KEY_RING={"2026-09":"already-configured-root"}',
    '',
  ].join('\n')
  const { envFile } = withEnvFile(contents)

  const result = runPreflight(envFile)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(envFile, 'utf8'), contents)
})
