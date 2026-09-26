import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunDecisionEvaluator } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'

import type { ExecutionDependencies, RunContext } from './types.js'
import { resolveRollingWatch } from './watch-status-gate.js'

/**
 * Jev answers a recurring sweep's disposition first; the generative
 * classifier is asked only when Jev is unsure, failing, or absent.
 */

const deps = {
  prisma: {
    run: { findUnique: async () => ({ triggerId: 'trigger-1' }) },
    agentTrigger: { findUnique: async () => ({ config: { rollingStatus: true }, type: 'interval' }) },
  },
} as unknown as ExecutionDependencies
const payload = { interactive: false } as RunExecuteJobPayload
const context = { run: { id: 'run-1' } } as RunContext

const jev = (choice: 'post' | 'status', probability: number): RunDecisionEvaluator => async () => ({
  disposition: { type: 'choice', choice, probabilities: { [choice]: probability } },
})

const classifier = (disposition: 'post' | 'status') => {
  let calls = 0
  return {
    calls: () => calls,
    runUtility: async () => {
      calls += 1
      return { outputText: JSON.stringify({ disposition }) }
    },
  }
}

test('a sure "nothing new" from Jev folds the sweep without the generative classifier', async () => {
  const generative = classifier('post')
  const result = await resolveRollingWatch(deps, payload, context, {
    decide: jev('status', 0.93), responseText: 'Všechno běží, beze změn.', runUtility: generative.runUtility,
  })
  assert.deepEqual(result, { triggerId: 'trigger-1' })
  assert.equal(generative.calls(), 0)
})

test('a sure finding from Jev is posted without the generative classifier', async () => {
  const generative = classifier('status')
  const result = await resolveRollingWatch(deps, payload, context, {
    decide: jev('post', 0.97), responseText: 'Záloha v noci selhala.', runUtility: generative.runUtility,
  })
  assert.equal(result, null)
  assert.equal(generative.calls(), 0)
})

test('an unsure or failing Jev leaves the disposition to the generative classifier', async () => {
  const unsure = classifier('status')
  assert.deepEqual(await resolveRollingWatch(deps, payload, context, {
    decide: jev('status', 0.6), responseText: 'asi ok', runUtility: unsure.runUtility,
  }), { triggerId: 'trigger-1' })
  assert.equal(unsure.calls(), 1)

  const failing = classifier('post')
  assert.equal(await resolveRollingWatch(deps, payload, context, {
    decide: async () => { throw new Error('ledger down') }, responseText: 'asi ok', runUtility: failing.runUtility,
  }), null)
  assert.equal(failing.calls(), 1)

  const absent = classifier('status')
  assert.deepEqual(await resolveRollingWatch(deps, payload, context, {
    decide: null, responseText: 'asi ok', runUtility: absent.runUtility,
  }), { triggerId: 'trigger-1' })
  assert.equal(absent.calls(), 1)
})
