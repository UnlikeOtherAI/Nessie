import assert from 'node:assert/strict'
import test from 'node:test'

import { startExecutorLocalInferenceSupervisor } from '../src/local-inference-supervisor.js'

test('local inference registration failure leaves the executor live and reconnects later', async () => {
  const state = { executorId: 'executor-1' } as never
  let enabled = false
  let heartbeats = 0
  const connect = async () => {
    if (!enabled) throw new Error('LOCAL_HOST_UNAVAILABLE')
    return {
      loop: {
        heartbeat: async () => { heartbeats += 1 },
        pollOnce: async () => ({ kind: 'idle' as const }),
      },
      state,
    }
  }
  const local = await startExecutorLocalInferenceSupervisor('state-dir', state, connect as never)
  assert.equal(local.state, state)
  await local.supervisor.poll()
  assert.equal(heartbeats, 0)
  enabled = true
  await local.supervisor.heartbeat()
  assert.equal(heartbeats, 1)
})

test('local reconnect failure retains the latest core executor state', async () => {
  const initial = { executorId: 'first' } as never
  const latest = { executorId: 'latest' } as never
  const local = await startExecutorLocalInferenceSupervisor('state-dir', initial, async () => {
    throw new Error('LOCAL_HOST_UNAVAILABLE')
  })
  assert.equal(await local.supervisor.reconnect(latest), latest)
})
