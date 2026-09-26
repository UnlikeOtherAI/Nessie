import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildChannelLink,
  buildMessageLink,
  formatAgentMarkdownLink,
  formatChannelMarkdownLink,
  formatMessageLine,
  formatProjectMarkdownLink,
  formatTriggerMarkdownLink,
} from './tool-output.js'

test('buildChannelLink builds a relative channel path', () => {
  assert.equal(buildChannelLink('chan-1'), '/channels/chan-1')
})

test('buildMessageLink anchors a reply to its root when the hit is a reply', () => {
  assert.equal(
    buildMessageLink({
      channelId: 'chan-1',
      messageId: 'msg-reply',
      rootMessageId: 'msg-root',
      threadId: 'thread-1',
    }),
    '/channels/chan-1/threads/thread-1/replies/msg-root',
  )
})

test('buildMessageLink anchors to the message itself when it is a top-level root', () => {
  assert.equal(
    buildMessageLink({
      channelId: 'chan-1',
      messageId: 'msg-root',
      rootMessageId: null,
      threadId: 'thread-1',
    }),
    '/channels/chan-1/threads/thread-1/replies/msg-root',
  )
})

test('formatMessageLine includes a ready-made link line the model can quote verbatim', () => {
  const line = formatMessageLine({
    author: 'Aria',
    channelId: 'chan-1',
    channelLabel: '#general (Acme / Core)',
    createdAt: '2026-08-05T10:00:00.000Z',
    messageId: 'msg-reply',
    rootMessageId: 'msg-root',
    snippet: 'the shortlist we discussed',
    threadLabel: 'Rollout plan',
    threadId: 'thread-1',
  })

  assert.match(line, /^- Aria \| #general \(Acme \/ Core\) \/ Rollout plan$/m)
  assert.match(line, /messageId=msg-reply \| threadId=thread-1$/m)
  assert.match(
    line,
    /^ {2}link=\/channels\/chan-1\/threads\/thread-1\/replies\/msg-root$/m,
  )
  assert.match(line, /the shortlist we discussed$/m)
})

test('a placed agent and its room are markdown links a person can follow', () => {
  assert.equal(
    formatChannelMarkdownLink({ id: 'chan-1', label: 'sales' }),
    '[#sales](/channels/chan-1)',
  )
  assert.equal(formatAgentMarkdownLink({ id: 'agent-1', name: 'CTO' }), '[CTO](/admin/agents/agent-1)')
})

test('a project and a trigger link to their own admin pages', () => {
  assert.equal(
    formatProjectMarkdownLink({ id: 'project-1', name: 'Marketing' }),
    '[Marketing](/projects/project-1)',
  )
  assert.equal(
    formatTriggerMarkdownLink({ id: 'trigger-1', name: 'Daily digest [UTC]' }),
    '[Daily digest \\[UTC\\]](/admin/automations/triggers/trigger-1)',
  )
})

test('a bracket in a name cannot end the link text early', () => {
  assert.equal(
    formatAgentMarkdownLink({ id: 'agent-1', name: 'Ops [beta]' }),
    '[Ops \\[beta\\]](/admin/agents/agent-1)',
  )
})
