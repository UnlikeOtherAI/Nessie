import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkflowStateEntryRecordSchema } from '../src/contracts.js'

test('WorkflowStateEntryRecordSchema validates workflow-scoped state records', () => {
  const record = WorkflowStateEntryRecordSchema.parse({
    createdAt: '2026-04-15T00:00:00.000Z',
    id: '11111111-1111-1111-1111-111111111111',
    key: 'cursor',
    organizationId: '22222222-2222-2222-2222-222222222222',
    updatedAt: '2026-04-15T00:00:00.000Z',
    value: {
      lastId: 'release-2',
    },
    valueHash: 'stored-hash',
    version: 2,
    workflowInstallationId: '33333333-3333-3333-3333-333333333333',
    workflowRunId: '44444444-4444-4444-4444-444444444444',
    workflowStepRunId: '55555555-5555-5555-5555-555555555555',
  })

  assert.equal(record.key, 'cursor')
  assert.equal(record.version, 2)
  assert.deepEqual(record.value, {
    lastId: 'release-2',
  })
})
