import assert from 'node:assert/strict'
import test from 'node:test'

import {
  approveExecutorPairingOrigin,
  EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN,
  EXECUTOR_PAIRING_PRESETS,
  executorPairingOriginLabel,
} from '../executor-pairing-origins.js'

test('a preset resolves to its pinned origin and names the service', () => {
  assert.deepEqual(
    EXECUTOR_PAIRING_PRESETS.map((preset) => [preset.id, preset.apiBaseUrl]),
    [['nessie', 'https://api.nessie.works'], ['deeptest', 'https://api.deeptest.live']],
  )
  assert.deepEqual(
    approveExecutorPairingOrigin('nessie'),
    { ok: true, origin: 'https://api.nessie.works', presetId: 'nessie' },
  )
  assert.equal(executorPairingOriginLabel('https://api.deeptest.live'), 'DeepTest')
})

test('a self-hosted Nessie is approved, and named by its host rather than "custom"', () => {
  assert.deepEqual(
    approveExecutorPairingOrigin('https://nessie.example.com'),
    { ok: true, origin: 'https://nessie.example.com' },
  )
  // A trailing slash is the same origin, not a second one to review.
  assert.deepEqual(
    approveExecutorPairingOrigin('https://nessie.example.com/'),
    { ok: true, origin: 'https://nessie.example.com' },
  )
  assert.equal(executorPairingOriginLabel('https://nessie.example.com'), 'nessie.example.com')
})

test('what a pairing address may never be', () => {
  // Plain HTTP would put the pairing challenge on the network.
  assert.equal(approveExecutorPairingOrigin('http://nessie.example.com').ok, false)
  // A path is how one host is made to read as another in a label.
  assert.equal(approveExecutorPairingOrigin('https://evil.example.com/api.nessie.works').ok, false)
  assert.equal(approveExecutorPairingOrigin('https://nessie.example.com?next=x').ok, false)
  assert.equal(approveExecutorPairingOrigin('https://user:pass@nessie.example.com').ok, false)
  assert.equal(approveExecutorPairingOrigin('not a url').ok, false)
  assert.equal(approveExecutorPairingOrigin('ftp://nessie.example.com').ok, false)
})

test('the local API is reachable only when a caller says it is a development build', () => {
  assert.equal(approveExecutorPairingOrigin(EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN).ok, false)
  assert.deepEqual(
    approveExecutorPairingOrigin(EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN, { allowLocalDevelopment: true }),
    { ok: true, origin: EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN },
  )
  // The hatch is that one origin, not "any http on loopback".
  assert.equal(
    approveExecutorPairingOrigin('http://127.0.0.1:9999', { allowLocalDevelopment: true }).ok,
    false,
  )
})
