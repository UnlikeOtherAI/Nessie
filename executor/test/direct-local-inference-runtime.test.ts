import assert from 'node:assert/strict'
import test from 'node:test'

import { superviseDirectLocalInference } from '../src/direct-local-inference-runtime.js'

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds)
})

const waitUntil = async (
  satisfied: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!satisfied() && Date.now() < deadline) await pause(1)
}

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
  // Waiting a fixed 35ms for two 12ms heartbeats assumed the scheduler
  // would keep up: on a loaded CI runner it did not, and a required check
  // failed on a change that touches nothing here. Wait for the condition the
  // test is actually about, with a deadline generous enough that only a real
  // stall trips it.
  await waitUntil(() => heartbeats >= 2)
  release?.()
  await supervised
  assert.ok(heartbeats >= 2)
  assert.equal(maxConcurrentHeartbeats, 1)
})

test('direct Desktop supervision aborts polling when a heartbeat loses authority', async () => {
  let release: (() => void) | null = null
  const stopped = new Promise<void>((resolve) => { release = resolve })
  let stoppedLoops = 0
  const releasePolls: Array<() => void> = []
  const loop = {
    heartbeat: async () => { throw new Error('LOCAL_HOST_UNAVAILABLE') },
    pollOnce: async () => new Promise<{ kind: 'idle' }>((resolve) => { releasePolls.push(() => resolve({ kind: 'idle' })) }),
    stop: () => { stoppedLoops += 1; for (const releasePoll of releasePolls) releasePoll() },
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
