import assert from 'node:assert/strict'
import test from 'node:test'

import type { ThreadMessageRecord } from '../src/lib/api-client.js'
import {
  readLivenessSignature,
  shouldShowLivenessHint,
  type LivenessSignature,
} from '../src/components/features/channels/liveness-hint.js'

const ME = 'user-me'

const message = (overrides: Partial<ThreadMessageRecord> = {}): ThreadMessageRecord => ({
  content: 'hello',
  createdAt: '2026-08-11T10:00:00.000Z',
  id: 'msg-1',
  role: 'user',
  threadId: 'thread-1',
  userId: ME,
  ...overrides,
})

const show = (
  baseline: LivenessSignature | null,
  current: LivenessSignature,
  hasPendingRun = false,
) => shouldShowLivenessHint({ baseline, current, hasPendingRun })

test('readLivenessSignature ignores the viewer’s own messages', () => {
  // The send completing is not a response to the send.
  const signature = readLivenessSignature(
    [
      message({ id: 'msg-1' }),
      message({ content: 'ahoj, môžeš to pozrieť?', id: 'msg-2' }),
    ],
    ME,
  )

  assert.deepEqual(signature, { agentReactionCount: 0, foreignMessageId: null })
})

test('readLivenessSignature takes the newest message from anyone else', () => {
  const signature = readLivenessSignature(
    [
      message({ id: 'msg-1', role: 'assistant', userId: null }),
      message({ id: 'msg-2' }),
      message({ agentId: 'agent-1', id: 'msg-3', role: 'assistant', userId: null }),
      message({ id: 'msg-4' }),
    ],
    ME,
  )

  assert.equal(signature.foreignMessageId, 'msg-3')
})

test('readLivenessSignature counts agent reactions only', () => {
  const reaction = (id: string, actor: { agentId?: string; userId?: string }) => ({
    createdAt: '2026-08-11T10:00:01.000Z',
    emoji: '👀',
    id,
    messageId: 'msg-1',
    ...actor,
  })
  const signature = readLivenessSignature(
    [
      message({
        id: 'msg-1',
        reactions: [
          reaction('r-1', { userId: ME }),
          reaction('r-2', { agentId: 'agent-1' }),
        ],
      }),
      message({ id: 'msg-2', reactions: [reaction('r-3', { agentId: 'agent-2' })] }),
    ],
    ME,
  )

  assert.equal(signature.agentReactionCount, 2)
})

test('no hint before the viewer has sent anything', () => {
  const now: LivenessSignature = { agentReactionCount: 0, foreignMessageId: null }

  assert.equal(show(null, now), false)
})

test('the hint holds while nothing at all has happened', () => {
  const baseline: LivenessSignature = { agentReactionCount: 0, foreignMessageId: 'msg-9' }

  assert.equal(show(baseline, { ...baseline }), true)
})

test('a pending run clears the hint — the bubble is the indicator', () => {
  const baseline: LivenessSignature = { agentReactionCount: 0, foreignMessageId: null }

  assert.equal(show(baseline, { ...baseline }, true), false)
})

test('a message from anyone else clears the hint', () => {
  const baseline: LivenessSignature = { agentReactionCount: 0, foreignMessageId: 'msg-9' }

  assert.equal(show(baseline, { ...baseline, foreignMessageId: 'msg-10' }), false)
})

test('an agent reaction clears the hint', () => {
  // `acknowledge` is a complete engagement outcome: a reaction, never a reply.
  const baseline: LivenessSignature = { agentReactionCount: 1, foreignMessageId: null }

  assert.equal(show(baseline, { ...baseline, agentReactionCount: 2 }), false)
})

test('the viewer’s own message arriving from the server does not clear the hint', () => {
  const before = readLivenessSignature([message({ id: 'msg-1' })], ME)
  const after = readLivenessSignature(
    [message({ id: 'msg-1' }), message({ content: 'sme tu?', id: 'msg-2' })],
    ME,
  )

  assert.equal(show(before, after), true)
})

test('an agent reply clears the hint end to end', () => {
  const before = readLivenessSignature([message({ id: 'msg-1' })], ME)
  const after = readLivenessSignature(
    [
      message({ id: 'msg-1' }),
      message({ agentId: 'agent-1', id: 'msg-2', role: 'assistant', userId: null }),
    ],
    ME,
  )

  assert.equal(show(before, after), false)
})
