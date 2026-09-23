import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolCallEntrySchema } from '../index.js'

// A tool call as an API from before the screenshots answered it: no `id`, no
// `attachments`. A newer client reading it during a rolling deploy must get
// an entry with no images, not a validation failure.
test('a tool call from an API that predates the screenshots still parses, with no images', () => {
  const entry = ToolCallEntrySchema.parse({
    inputSummary: 'server=kelpie',
    runId: '00000000-0000-4000-8000-000000000001',
    startedAt: '2026-09-23T10:00:00.000Z',
    toolName: 'executor_mcp_call',
  })
  assert.equal(entry.id, undefined)
  assert.deepEqual(entry.attachments, [])
})
