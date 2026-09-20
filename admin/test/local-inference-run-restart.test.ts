import assert from 'node:assert/strict'
import test from 'node:test'

import { readRunRestart } from '../src/components/features/channels/RunRestart.js'

test('a local-host terminal notice exposes only an explicitly server-authored restart', () => {
  assert.deepEqual(readRunRestart({
    runRestart: { restartable: true, runId: 'run-1' },
  }), { restartable: true, runId: 'run-1' })
})

test('model-authored or malformed metadata cannot create a run restart control', () => {
  assert.equal(readRunRestart({ runRestart: { runId: 'run-1' } }), null)
  assert.equal(readRunRestart({ runRestart: { restartable: true, runId: '' } }), null)
  assert.equal(readRunRestart({ runRestart: { restartable: false, runId: 'run-1' } }), null)
})
