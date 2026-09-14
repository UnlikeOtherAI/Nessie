import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  conflictCount,
  exitCodeFor,
  parseBatchSize,
} from '../src/db/rotate-at-rest-secrets-cli.js'

test('rotation CLI accepts only bounded explicit batch sizes', () => {
  assert.equal(parseBatchSize([]), undefined)
  assert.equal(parseBatchSize(['--batch-size', '1000']), 1000)
  assert.throws(() => parseBatchSize(['--batch-size', '0']), /1 to 1000/u)
  assert.throws(() => parseBatchSize(['--batch-size=100']), /Usage/u)
})

test('rotation CLI reports conflicts as a non-success result condition', () => {
  assert.equal(conflictCount({ first: { conflicts: 0 }, second: { conflicts: 2 } }), 2)
  assert.equal(exitCodeFor({ first: { conflicts: 1 } }), 2)
  assert.equal(exitCodeFor({ first: { conflicts: 0 } }), 0)
})

test('rotation CLI returns one when its encryption configuration is invalid', () => {
  const cli = fileURLToPath(new URL(
    '../src/db/rotate-at-rest-secrets-cli.ts',
    import.meta.url,
  ))
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli], {
    encoding: 'utf8',
    env: {
      NESSIE_AUTH_SECRET: 'a'.repeat(64),
      NESSIE_MODE: 'selfHosted',
    },
  })

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /At-rest secret rotation failed/u)
})
