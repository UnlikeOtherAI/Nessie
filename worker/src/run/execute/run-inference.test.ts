import assert from 'node:assert/strict'
import test from 'node:test'

import { KB_DOCUMENT_COMPOSE_TOOL_ID } from '@nessie/runtime'

import { hasDocumentComposeTool } from './run-inference.js'

test('compose output capacity is detected by tool name even with a stub descriptor', () => {
  assert.equal(hasDocumentComposeTool([{
    toolName: KB_DOCUMENT_COMPOSE_TOOL_ID,
    description: 'compact summary only',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      description: 'Call tool_spec first for the exact argument schema.',
    },
  }]), true)

  assert.equal(hasDocumentComposeTool([{
    toolName: 'kb_document_edit',
    description: 'same cluster, different name',
    inputSchema: { type: 'object' },
  }]), false)
})
