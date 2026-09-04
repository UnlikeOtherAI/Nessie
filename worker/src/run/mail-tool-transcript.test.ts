import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'
import {
  hasProtectedMailContext,
  PROTECTED_MAIL_ASSISTANT_CONTENT_MARKER,
  projectMailToolResultsForUtilityTranscript,
} from './mail-tool-transcript.js'
import {
  EMAIL_ACCOUNT_TOOL_IDS,
  PROTECTED_MAIL_TOOL_SUMMARIES,
} from './tool-util.js'

const protectedMailTools = [
  ...Object.keys(PROTECTED_MAIL_TOOL_SUMMARIES),
  ...EMAIL_ACCOUNT_TOOL_IDS,
]

test('projects every protected mail tool result by its owning call while retaining other results', () => {
  const privateToken = 'recipient@private.example SUBJECT-PRIVATE body-private 00000000-0000-0000-0000-0000000000ee'
  const messages: ProviderMessage[] = [
    {
      content: null,
      role: 'assistant',
      toolCalls: protectedMailTools.map((toolName, index) => ({
        arguments: {},
        toolCallId: `mail-${index}`,
        toolName,
      })),
    },
    ...protectedMailTools.map((_, index) => ({
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

  for (const result of toolResults.slice(0, protectedMailTools.length)) {
    assert.doesNotMatch(
      result.content,
      /recipient@private\.example|SUBJECT-PRIVATE|body-private|00000000-0000-0000-0000-0000000000ee/,
    )
    assert.match(result.content, /withheld from utility transcript/)
  }
  assert.equal(toolResults.at(-1)?.content, 'ordinary tool output remains available')
})

test('a protected tool call makes the entire inference context mail-sensitive', () => {
  const messages: ProviderMessage[] = [{
    content: null,
    role: 'assistant',
    toolCalls: [{
      arguments: { to: 'recipient@private.example' },
      toolCallId: 'mail',
      toolName: 'email_send',
    }],
  }]

  assert.equal(hasProtectedMailContext(messages), true)
  assert.equal(hasProtectedMailContext([{ content: 'ordinary', role: 'user' }]), false)
})

test('utility projection withholds assistant prose after protected mail without changing inference context', () => {
  const privateAssistantText = 'The private message says body-private for recipient@private.example.'
  const messages: ProviderMessage[] = [
    { content: 'ordinary assistant state stays available', role: 'assistant' },
    {
      content: null,
      role: 'assistant',
      toolCalls: [{ arguments: {}, toolCallId: 'mail', toolName: 'gmail_message_read' }],
    },
    { content: 'provider-private-token', role: 'tool', toolCallId: 'mail' },
    { content: privateAssistantText, role: 'assistant' },
  ]

  const projected = projectMailToolResultsForUtilityTranscript(messages)

  assert.equal(projected[0]?.content, 'ordinary assistant state stays available')
  assert.equal(projected[1]?.content, PROTECTED_MAIL_ASSISTANT_CONTENT_MARKER)
  assert.equal(projected[3]?.content, PROTECTED_MAIL_ASSISTANT_CONTENT_MARKER)
  assert.equal(messages[3]?.content, privateAssistantText)
})
