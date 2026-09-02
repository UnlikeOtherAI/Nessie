import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentTriggerActivityRecord, AgentTriggerRecord } from '../src/lib/api-client'
import {
  findTriggerActivity,
  groupTriggers,
} from '../src/components/features/triggers/trigger-groups'

const trigger = (
  id: string,
  type: AgentTriggerRecord['type'],
): AgentTriggerRecord => ({
  config: {},
  createdAt: new Date(0).toISOString(),
  enabled: true,
  id,
  status: 'active',
  type,
  updatedAt: new Date(0).toISOString(),
})

const activity = (
  triggerId: string,
  overrides: Partial<AgentTriggerActivityRecord> = {},
): AgentTriggerActivityRecord => ({
  lastFinishedAt: null,
  lastOutcome: null,
  running: [],
  triggerId,
  ...overrides,
})

test('time-based triggers lead, and a cron and an interval share one group', () => {
  const groups = groupTriggers([
    trigger('m', 'manual'),
    trigger('w', 'webhook'),
    trigger('i', 'interval'),
    trigger('e', 'event'),
    trigger('s', 'scheduled'),
  ])

  assert.deepEqual(groups.map((group) => group.key), ['time', 'event', 'webhook', 'manual'])
  assert.deepEqual(groups[0]?.triggers.map((entry) => entry.id), ['i', 's'])
})

test('a group with nothing in it is not rendered as an empty heading', () => {
  const groups = groupTriggers([trigger('s', 'scheduled')])
  assert.deepEqual(groups.map((group) => group.key), ['time'])
})

test('every trigger type lands in exactly one group', () => {
  const types: Array<AgentTriggerRecord['type']> = [
    'manual',
    'scheduled',
    'webhook',
    'event',
    'interval',
  ]
  const groups = groupTriggers(types.map((type) => trigger(type, type)))
  const placed = groups.flatMap((group) => group.triggers.map((entry) => entry.id))

  assert.equal(placed.length, types.length)
  assert.deepEqual([...placed].sort(), [...types].sort())
})

test('two concurrent executions stay two entries, never a flag', () => {
  const entry = activity('s', {
    running: [
      { deliveryId: 'd1', runId: 'r1', startedAt: null, status: 'running' },
      { deliveryId: 'd2', runId: 'r2', startedAt: null, status: 'pending' },
    ],
  })

  const found = findTriggerActivity([entry], 's')
  assert.equal(found?.running.length, 2)
  // Each is nameable by its own delivery, so nothing has to be inferred from
  // timestamps to tell them apart.
  assert.deepEqual(found?.running.map((run) => run.deliveryId), ['d1', 'd2'])
})

test('a trigger with no activity row reads as unknown, not as finished', () => {
  assert.equal(findTriggerActivity([activity('other')], 's'), undefined)
})
