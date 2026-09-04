import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolCircuitBreaker } from './circuit-breaker.js'
import { executeToolBatch } from './tool-batch.js'

test('policy preflight summaries, not raw rejected account arguments, reach callbacks', async () => {
  const starts: string[] = []
  const ends: unknown[] = []
  const oauthCode = 'code-for-owner@example.test'

  await executeToolBatch({
    callbacks: {
      onToolCallEnd: async (_toolName, args) => { ends.push(args) },
      onToolCallStart: async (_toolName, inputSummary) => { starts.push(inputSummary) },
    },
    circuitBreaker: new ToolCircuitBreaker(),
    executeTool: async () => {
      throw new Error('the preflight result should execute instead')
    },
    prepareTool: async () => ({
      execute: async () => ({
        inputSummary: 'Invalid tool input.',
        output: 'The tool arguments were invalid. Use only the documented fields.',
        success: false,
      }),
      inputSummary: 'Invalid tool input.',
      kind: 'execute',
    }),
    signatureCounts: new Map(),
    toolCalls: [{
      arguments: { oauthCode },
      toolCallId: 'call-1',
      toolName: 'email_account_connect',
    }],
  })

  assert.deepEqual(starts, ['Invalid tool input.'])
  assert.deepEqual(ends, [{}])
  assert.doesNotMatch(JSON.stringify({ ends, starts }), /owner@example\.test|oauthCode/)
})

test('mailbox send callbacks keep PII out of start and persistence arguments', async () => {
  const starts: string[] = []
  const ends: unknown[] = []
  const args = {
    subject: 'Private subject',
    text: 'Private body',
    to: ['recipient@example.test'],
  }

  await executeToolBatch({
    callbacks: {
      onToolCallEnd: async (_toolName, persistedArgs) => { ends.push(persistedArgs) },
      onToolCallStart: async (_toolName, inputSummary) => { starts.push(inputSummary) },
    },
    circuitBreaker: new ToolCircuitBreaker(),
    executeTool: async () => ({
      inputSummary: 'Send from a connected mailbox.',
      output: 'Sent from sender@example.test to recipient@example.test.',
      success: true,
    }),
    signatureCounts: new Map(),
    toolCalls: [{ arguments: args, toolCallId: 'call-2', toolName: 'mailbox_send' }],
  })

  assert.deepEqual(starts, ['Send from a connected mailbox.'])
  assert.deepEqual(ends, [{}])
  assert.doesNotMatch(JSON.stringify({ ends, starts }), /recipient@example\.test|Private subject|Private body/)
})
