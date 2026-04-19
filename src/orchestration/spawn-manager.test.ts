/**
 * src/orchestration/spawn-manager.test.ts — Circuit breaker tests for SpawnManager.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { AnnouncePayload } from './spawn-manager.js'
import { SpawnManager, CommandLaneCircuitBreakerError } from './spawn-manager.js'
import { TaskLedger } from './task-ledger.js'

const noopOnComplete = (_taskId: string, _payload: AnnouncePayload) => {}

test('SpawnManager: normal queuing continues below circuitBreakerDepth', () => {
  const ledger = new TaskLedger()
  const manager = new SpawnManager(ledger, noopOnComplete, {
    maxSpawnDepth: 3,
    maxChildrenPerAgent: 5,
    maxConcurrent: 10,
    circuitBreakerDepth: 9,
    circuitBreakerWaitMs: 600_000,
  })

  // Spawn 5 tasks — well below the threshold of 9
  for (let i = 0; i < 5; i++) {
    const result = manager.spawn({
      parentTaskId: null,
      role: 'researcher',
      label: `task-${i}`,
      toolScope: ['Bash'],
      timeoutSeconds: 60,
    })
    assert.equal(result.accepted, true, `task ${i} should be accepted`)
  }
})

test('SpawnManager: breaker triggers when queue depth >= circuitBreakerDepth', () => {
  const ledger = new TaskLedger()
  const manager = new SpawnManager(ledger, noopOnComplete, {
    maxSpawnDepth: 3,
    maxChildrenPerAgent: 5,
    maxConcurrent: 10,
    circuitBreakerDepth: 9,
    circuitBreakerWaitMs: 600_000,
  })

  // Spawn 9 tasks — when 9th is added, activeSpawns.size becomes 9, >= threshold
  for (let i = 0; i < 9; i++) {
    const result = manager.spawn({
      parentTaskId: null,
      role: 'researcher',
      label: `task-${i}`,
      toolScope: ['Bash'],
      timeoutSeconds: 60,
    })
    assert.equal(result.accepted, true)
  }
  // Now activeSpawns.size == 9, circuit breaker is armed

  // 10th task should trip the circuit breaker (9 >= 9 triggers check BEFORE queuing)
  assert.throws(
    () =>
      manager.spawn({
        parentTaskId: null,
        role: 'researcher',
        label: 'task-breaker',
        toolScope: ['Bash'],
        timeoutSeconds: 60,
      }),
    CommandLaneCircuitBreakerError,
    '10th spawn should trip circuit breaker at depth >= 9',
  )
})

test('SpawnManager: breaker triggers when oldest entry wait >= circuitBreakerWaitMs', () => {
  const ledger = new TaskLedger()
  const manager = new SpawnManager(ledger, noopOnComplete, {
    maxSpawnDepth: 3,
    maxChildrenPerAgent: 5,
    maxConcurrent: 10,
    circuitBreakerDepth: 20, // high enough that depth doesn't trigger
    circuitBreakerWaitMs: 50, // 50ms threshold so we don't wait real time
  })

  // Spawn one task
  const result = manager.spawn({
    parentTaskId: null,
    role: 'researcher',
    label: 'slow-task',
    toolScope: ['Bash'],
    timeoutSeconds: 5,
  })
  assert.equal(result.accepted, true)

  // Manipulate enqueuedAt to simulate an old entry (testing internal state via cast)
  const spawns = manager as unknown as {
    activeSpawns: Map<string, { taskId: string; enqueuedAt: number }>
  }
  for (const spawn of spawns.activeSpawns.values()) {
    spawn.enqueuedAt = Date.now() - 100 // 100ms ago, exceeds 50ms threshold
  }

  // Next spawn should trip on wait threshold
  assert.throws(
    () =>
      manager.spawn({
        parentTaskId: null,
        role: 'researcher',
        label: 'new-task',
        toolScope: ['Bash'],
        timeoutSeconds: 60,
      }),
    CommandLaneCircuitBreakerError,
    'spawn with old entry wait >= threshold should trip circuit breaker',
  )
})

test('CommandLaneCircuitBreakerError has correct properties', () => {
  const err = new CommandLaneCircuitBreakerError('test message', 30_000)
  assert.equal(err.name, 'CommandLaneCircuitBreakerError')
  assert.equal(err.message, 'test message')
  assert.equal(err.retryAfterMs, 30_000)
  assert.equal(err instanceof Error, true)
})

test('CommandLaneCircuitBreakerError retryAfterMs is optional', () => {
  const err = new CommandLaneCircuitBreakerError('no-retry-hint')
  assert.equal(err.retryAfterMs, undefined)
})