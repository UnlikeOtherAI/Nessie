/**
 * src/orchestration/spawn-manager.test.ts — Circuit breaker tests for SpawnManager.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { AnnouncePayload, SpawnRequest } from './spawn-manager.js'
import { SpawnManager, CommandLaneCircuitBreakerError } from './spawn-manager.js'
import { TaskLedger } from './task-ledger.js'

const noopOnComplete = (_taskId: string, _payload: AnnouncePayload) => {}

// ─── Session-scoped lane tests ─────────────────────────────────────────────────

test('SpawnManager: researcher with parent in non-main session → session-scoped nested lane', () => {
  const ledger = new TaskLedger()
  const manager = new SpawnManager(ledger, noopOnComplete)

  // Create a parent task in a non-main session (threadId)
  const parent = ledger.createTask({
    parentId: null,
    threadId: 'agent:session:abc',
    role: 'orchestrator',
    label: 'parent task',
    assignedModel: null,
    timeoutSeconds: 60,
    specPath: null,
    outputPath: null,
  })

  // Spawn a researcher child — lane should be scoped to the session
  const result = manager.spawn({
    parentTaskId: parent.id,
    role: 'researcher',
    label: 'child research task',
    toolScope: ['WebSearch'],
    timeoutSeconds: 60,
  })

  assert.equal(result.accepted, true)

  // Verify the task was assigned the session-scoped lane
  const taskLanes = manager as unknown as { taskLanes: Map<string, string> }
  const lane = taskLanes.taskLanes.get(result.taskId)
  assert.equal(lane, 'nested:agent:session:abc',
    'researcher with non-main parent should get session-scoped lane')
})

test('SpawnManager: researcher without parent → bare nested lane', () => {
  const ledger = new TaskLedger()
  const manager = new SpawnManager(ledger, noopOnComplete)

  const result = manager.spawn({
    parentTaskId: null,
    role: 'researcher',
    label: 'orphan research task',
    toolScope: ['WebSearch'],
    timeoutSeconds: 60,
  })

  assert.equal(result.accepted, true)

  const taskLanes = manager as unknown as { taskLanes: Map<string, string> }
  const lane = taskLanes.taskLanes.get(result.taskId)
  assert.equal(lane, 'nested',
    'researcher without parent should get bare nested lane')
})

test('SpawnManager: researcher with parent in main session → bare nested lane', () => {
  const ledger = new TaskLedger()
  const manager = new SpawnManager(ledger, noopOnComplete)

  // Parent in 'main' thread → should fallback to bare 'nested'
  const parent = ledger.createTask({
    parentId: null,
    threadId: 'main',
    role: 'orchestrator',
    label: 'main parent',
    assignedModel: null,
    timeoutSeconds: 60,
    specPath: null,
    outputPath: null,
  })

  const result = manager.spawn({
    parentTaskId: parent.id,
    role: 'researcher',
    label: 'main session research',
    toolScope: ['WebSearch'],
    timeoutSeconds: 60,
  })

  assert.equal(result.accepted, true)

  const taskLanes = manager as unknown as { taskLanes: Map<string, string> }
  const lane = taskLanes.taskLanes.get(result.taskId)
  assert.equal(lane, 'nested',
    'researcher with main-session parent should get bare nested lane')
})

test('SpawnManager: non-researcher roles → role name as lane', () => {
  const ledger = new TaskLedger()
  const manager = new SpawnManager(ledger, noopOnComplete)

  for (const role of ['orchestrator', 'builder', 'watcher'] as const) {
    const result = manager.spawn({
      parentTaskId: null,
      role,
      label: `${role} task`,
      toolScope: ['Bash'],
      timeoutSeconds: 60,
    })
    assert.equal(result.accepted, true, `${role} should be accepted`)

    const taskLanes = manager as unknown as { taskLanes: Map<string, string> }
    const lane = taskLanes.taskLanes.get(result.taskId)
    assert.equal(lane, role, `${role} should use its role name as lane`)
  }
})

test('SpawnManager: explicit lane override → uses provided lane', () => {
  const ledger = new TaskLedger()
  const manager = new SpawnManager(ledger, noopOnComplete)

  const result = manager.spawn({
    parentTaskId: null,
    role: 'researcher',
    label: 'custom lane task',
    toolScope: ['WebSearch'],
    timeoutSeconds: 60,
    lane: 'my-custom-lane',
  })

  assert.equal(result.accepted, true)

  const taskLanes = manager as unknown as { taskLanes: Map<string, string> }
  const lane = taskLanes.taskLanes.get(result.taskId)
  assert.equal(lane, 'my-custom-lane', 'explicit lane override should be used')
})

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
  const breakerResult = manager.spawn({
    parentTaskId: null,
    role: 'researcher',
    label: 'task-breaker',
    toolScope: ['Bash'],
    timeoutSeconds: 100,
  })
  assert.equal(breakerResult.accepted, false, '10th spawn should trip circuit breaker at depth >= 9')
  assert.equal(breakerResult.retryAfterMs, 30_000)
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
    laneStates: Map<string, Map<string, { taskId: string; enqueuedAt: number }>>
  }
  for (const laneMap of spawns.laneStates.values()) {
    for (const spawn of laneMap.values()) {
      spawn.enqueuedAt = Date.now() - 100 // 100ms ago, exceeds 50ms threshold
    }
  }

  // Next spawn should trip on wait threshold
  const breakerResult = manager.spawn({
    parentTaskId: null,
    role: 'researcher',
    label: 'new-task',
    toolScope: ['Bash'],
    timeoutSeconds: 100,
  })
  assert.equal(breakerResult.accepted, false, 'spawn with old entry wait >= threshold should trip circuit breaker')
  assert.equal(breakerResult.retryAfterMs, 30_000)
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