import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { alive, createCodingHarness, waitUntil } from './coding-session-harness.js'

/**
 * The config's hard limits, over the real bridge: a runaway turn is
 * interrupted at maxTurnMinutes, and an idle agent process is ended at
 * idleMinutes while its session stays resumable.
 */

test('a turn that runs past maxTurnMinutes is interrupted and says why', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ codingSessions: { maxTurnMinutes: 0.05 } })
  try {
    const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: '#sleep=120000 runaway' })
    const sessionId = started.body.sessionId as string
    const stopped = await harness.waitForStatus(sessionId, (body) => body.status === 'interrupted', undefined, 60_000)
    assert.equal((stopped.lastResult as { subtype: string }).subtype, 'error_during_execution')
    const events = await harness.call('session_status', { sessionId, detail: 'events', cursor: '0.0.0' })
    assert.ok((events.body.events as { subtype?: string; reason?: string }[])
      .some((event) => event.subtype === 'limit' && event.reason === 'max_turn_minutes'))
  } finally {
    await harness.cleanup()
  }
})

test('an idle agent is ended, its host leaves, and the next message resumes the same session', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ codingSessions: { idleMinutes: 0.05 } })
  try {
    const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'short task' })
    const sessionId = started.body.sessionId as string
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    const first = (await harness.agents()).find((entry) => entry.event === 'start')!
    const lock = join(harness.stateDir, 'sessions', sessionId, 'host.lock')
    await waitUntil(async () => (!alive(first.pid as number) && !existsSync(lock) ? true : undefined), 30_000, 'the idle agent to end')
    assert.equal((await harness.call('session_status', { sessionId })).body.status, 'waiting_for_input', 'idle is not lost')
    await harness.call('session_send', { sessionId, message: 'one more thing' })
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input' && body.turn === 2)
    assert.match((done.lastResult as { text: string }).text, /one more thing/)
    const starts = (await harness.agents()).filter((entry) => entry.event === 'start')
    assert.deepEqual(starts.map((entry) => entry.resume), [false, true])
    assert.equal(starts[1]!.sessionId, first.sessionId)
  } finally {
    await harness.cleanup()
  }
})
