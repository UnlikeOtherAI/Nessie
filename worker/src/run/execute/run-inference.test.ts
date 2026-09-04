import assert from 'node:assert/strict'
import test from 'node:test'

import { KB_DOCUMENT_COMPOSE_TOOL_ID } from '@nessie/runtime'

import type { ThinkingRecorder } from './thinking-recorder.js'
import { hasDocumentComposeTool, recordVisibleReasoning } from './run-inference.js'

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

test('protected mail in an inference replaces visible reasoning before its recorder sink', async () => {
  const appended: string[] = []
  let withheld = 0
  const thinkingRecorder = {
    appendReasoning: async (chunk: string) => { appended.push(chunk) },
    appendWithheldMailReasoning: async () => { withheld += 1 },
  } as unknown as ThinkingRecorder

  await recordVisibleReasoning({
    chunks: ['Send body-private to recipient@private.example.'],
    protectedContext: false,
    thinkingRecorder,
    toolCalls: [{ arguments: {}, toolCallId: 'mail', toolName: 'email_send' }],
  })

  assert.deepEqual(appended, [])
  assert.equal(withheld, 1)
})

test('protected mail already in context replaces later visible reasoning', async () => {
  const appended: string[] = []
  let withheld = 0
  const thinkingRecorder = {
    appendReasoning: async (chunk: string) => { appended.push(chunk) },
    appendWithheldMailReasoning: async () => { withheld += 1 },
  } as unknown as ThinkingRecorder

  await recordVisibleReasoning({
    chunks: ['The private body said body-private.'],
    protectedContext: true,
    thinkingRecorder,
    toolCalls: [],
  })

  assert.deepEqual(appended, [])
  assert.equal(withheld, 1)
})
