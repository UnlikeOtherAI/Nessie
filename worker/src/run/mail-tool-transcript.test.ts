import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'
import { projectMailToolResultsForUtilityTranscript } from './mail-tool-transcript.js'

const correspondenceTools = [
  'email_list',
  'email_read',
  'email_send',
  'mailbox_search',
  'mailbox_read',
  'mailbox_send',
  'gmail_search',
  'gmail_thread_read',
  'gmail_message_read',
  'gmail_attachment_read',
  'gmail_draft_create',
  'gmail_draft_update',
  'gmail_draft_send',
  'contacts_search',
]

test('projects every correspondence tool result by the owning tool call while retaining other results', () => {
  const privateToken = 'recipient@private.example SUBJECT-PRIVATE body-private provider-private'
  const messages: ProviderMessage[] = [
    {
      content: null,
      role: 'assistant',
      toolCalls: correspondenceTools.map((toolName, index) => ({
        arguments: {},
        toolCallId: `mail-${index}`,
        toolName,
      })),
    },
    ...correspondenceTools.map((_, index) => ({
      content: privateToken,
      role: 'tool' as const,
      toolCallId: `mail-${index}`,
    })),
    {
      content: null,
      role: 'assistant',
      toolCalls: [{ arguments: {}, toolCallId: 'ordinary', toolName: 'web_search' }],
    },
    { content: 'ordinary tool output remains available', role: 'tool', toolCallId: 'ordinary' },
  ]

  const projected = projectMailToolResultsForUtilityTranscript(messages)
  const toolResults = projected.filter((message) => message.role === 'tool')

  for (const result of toolResults.slice(0, correspondenceTools.length)) {
    assert.doesNotMatch(result.content, /recipient@private\.example|SUBJECT-PRIVATE|body-private|provider-private/)
    assert.match(result.content, /withheld from utility transcript/)
  }
  assert.equal(toolResults.at(-1)?.content, 'ordinary tool output remains available')
})
