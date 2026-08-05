import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunExecuteJobPayload } from '@nessie/schemas'
import { isInteractiveRun, shouldAutoContinue } from './continuation.js'

const payload = (interactive?: boolean): RunExecuteJobPayload =>
  ({ ...(interactive === undefined ? {} : { interactive }) }) as RunExecuteJobPayload

test('only a live human turn is interactive; automation never is', () => {
  assert.equal(isInteractiveRun(payload(true)), true)
  assert.equal(isInteractiveRun(payload(false)), false)
  // Triggers, schedules, workflows and mailbox runs leave the flag unset.
  assert.equal(isInteractiveRun(payload()), false)
})

test('an interactive run never auto-continues — it stops and offers the affordance', () => {
  assert.equal(shouldAutoContinue({ generation: 1, payload: payload(true) }), false)
})

test('non-interactive runs auto-continue up to the configured generation cap', () => {
  const previous = process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
  delete process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
  try {
    assert.equal(shouldAutoContinue({ generation: 1, payload: payload(false) }), true)
    assert.equal(shouldAutoContinue({ generation: 2, payload: payload() }), true)
    // Generation 3 is past the default cap of 2: stop terminally with the
    // checkpoint attached instead of continuing forever.
    assert.equal(shouldAutoContinue({ generation: 3, payload: payload() }), false)
    assert.equal(shouldAutoContinue({ generation: 9, payload: payload() }), false)
  } finally {
    if (previous === undefined) delete process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
    else process.env['NESSIE_RUN_AUTO_CONTINUATIONS'] = previous
  }
})

test('the cap is env-tunable, including fully disabled', () => {
  const previous = process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
  try {
    process.env['NESSIE_RUN_AUTO_CONTINUATIONS'] = '0'
    assert.equal(shouldAutoContinue({ generation: 1, payload: payload() }), false)
    process.env['NESSIE_RUN_AUTO_CONTINUATIONS'] = '4'
    assert.equal(shouldAutoContinue({ generation: 4, payload: payload() }), true)
    assert.equal(shouldAutoContinue({ generation: 5, payload: payload() }), false)
  } finally {
    if (previous === undefined) delete process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
    else process.env['NESSIE_RUN_AUTO_CONTINUATIONS'] = previous
  }
})
