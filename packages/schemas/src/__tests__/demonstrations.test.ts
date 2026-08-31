import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DemonstrationDetailRecordSchema,
  DemonstrationStatusSchema,
} from '../demonstrations.js'

const DEMONSTRATION = {
  agentId: '10000000-0000-4000-8000-000000000001',
  capturedAt: null,
  channelId: '10000000-0000-4000-8000-000000000002',
  expiresAt: '2026-08-31T13:00:00.000Z',
  id: '10000000-0000-4000-8000-000000000003',
  organizationId: '10000000-0000-4000-8000-000000000004',
  startedAt: '2026-08-31T09:00:00.000Z',
  startedByUserId: '10000000-0000-4000-8000-000000000005',
  status: 'captured',
  stepCount: 1,
  steps: [{
    agentId: '10000000-0000-4000-8000-000000000001',
    argumentsJson: { query: 'release notes' },
    demonstrationId: '10000000-0000-4000-8000-000000000003',
    durationMs: 10,
    endedAt: '2026-08-31T09:00:01.000Z',
    id: '10000000-0000-4000-8000-000000000006',
    runId: '10000000-0000-4000-8000-000000000007',
    sequence: 1,
    startedAt: '2026-08-31T09:00:00.000Z',
    success: true,
    toolName: 'web_search',
  }],
  threadId: '10000000-0000-4000-8000-000000000008',
}

test('demonstration draft records retain typed structural steps', () => {
  const parsed = DemonstrationDetailRecordSchema.parse(DEMONSTRATION)
  assert.equal(parsed.steps[0]?.toolName, 'web_search')
  assert.deepEqual(parsed.steps[0]?.argumentsJson, { query: 'release notes' })
})

test('demonstration status accepts only the durable demonstration lifecycle', () => {
  assert.equal(DemonstrationStatusSchema.safeParse('recording').success, true)
  assert.equal(DemonstrationStatusSchema.safeParse('replaying').success, false)
})
