import assert from 'node:assert/strict'
import test from 'node:test'

import { superviseDirectLocalInference } from '../src/direct-local-inference-runtime.js'

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds)
})

test('direct Desktop supervision keeps fresh inventory heartbeats non-overlapping', async () => {
  let release: (() => void) | null = null
  const stopped = new Promise<void>((resolve) => { release = resolve })
  let heartbeats = 0
  let concurrentHeartbeats = 0
  let maxConcurrentHeartbeats = 0
  const loop = {
    heartbeat: async () => {
      heartbeats += 1
      concurrentHeartbeats += 1
      maxConcurrentHeartbeats = Math.max(maxConcurrentHeartbeats, concurrentHeartbeats)
      await pause(12)
      concurrentHeartbeats -= 1
    },
    pollOnce: async () => {
      await pause(1)
      return { kind: 'idle' as const }
    },
    stop: () => undefined,
  }
  const supervised = superviseDirectLocalInference({
    heartbeatIntervalMs: 4,
    loop,
    pollIntervalMs: 1,
    stopped,
  })
  await pause(35)
  release?.()
  await supervised
  assert.ok(heartbeats >= 2)
  assert.equal(maxConcurrentHeartbeats, 1)
})

test('direct Desktop supervision aborts polling when a heartbeat loses authority', async () => {
  let release: (() => void) | null = null
  const stopped = new Promise<void>((resolve) => { release = resolve })
  let stoppedLoops = 0
  let releasePoll: (() => void) | null = null
  const loop = {
    heartbeat: async () => { throw new Error('LOCAL_HOST_UNAVAILABLE') },
    pollOnce: async () => new Promise<{ kind: 'idle' }>((resolve) => { releasePoll = () => resolve({ kind: 'idle' }) }),
    stop: () => { stoppedLoops += 1; releasePoll?.() },
  }
  await assert.rejects(
    superviseDirectLocalInference({
      heartbeatIntervalMs: 1,
      loop,
      pollIntervalMs: 1,
      stopped,
    }),
    /LOCAL_HOST_UNAVAILABLE/,
  )
  release?.()
  assert.equal(stoppedLoops, 1)
})
