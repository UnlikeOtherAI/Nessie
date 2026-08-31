import assert from 'node:assert/strict'
import test from 'node:test'

import { postOrchestrationNotice } from './orchestration-notice.js'

const AGENT_ID = '00000000-0000-0000-0000-0000000000a1'
const CHANNEL_ID = '00000000-0000-0000-0000-0000000000b1'
const THREAD_ID = '00000000-0000-0000-0000-0000000000c1'
const TRIGGER_MESSAGE_ID = '00000000-0000-0000-0000-0000000000d1'
const NOTICE_MESSAGE_ID = '00000000-0000-0000-0000-0000000000e1'

type CreateInput = { data: Record<string, unknown> }
type PublishedEvent = { data: Record<string, unknown>; event: string }

const makeDeps = (existingNotice = false) => {
  const creates: CreateInput[] = []
  const published: PublishedEvent[] = []
  const deps = {
    prisma: {
      message: {
        create: async (input: CreateInput) => {
          creates.push(input)
          return {
            content: input.data.content,
            createdAt: new Date('2026-08-31T10:00:00.000Z'),
            id: NOTICE_MESSAGE_ID,
          }
        },
        findFirst: async () => existingNotice ? { id: NOTICE_MESSAGE_ID } : null,
      },
    },
    realtimeTransport: {
      publishWs: async (_scopes: unknown, event: PublishedEvent) => {
        published.push(event)
      },
    },
  }
  return { creates, deps: deps as never, published }
}

const noticeInput = {
  agentId: AGENT_ID,
  channelId: CHANNEL_ID,
  content: '⚠️ Your team has no AI credits remaining. — this request was not run.',
  kind: 'credits_exhausted' as const,
  threadId: THREAD_ID,
  triggerMessageId: TRIGGER_MESSAGE_ID,
}

test('credit exhaustion posts one visible no-run notice in the triggering thread', async () => {
  const { creates, deps, published } = makeDeps()

  await postOrchestrationNotice(deps, noticeInput)

  assert.deepEqual(creates, [{
    data: {
      agentId: AGENT_ID,
      content: noticeInput.content,
      metadata: {
        orchestrationNotice: {
          kind: 'credits_exhausted',
          triggerMessageId: TRIGGER_MESSAGE_ID,
        },
      },
      role: 'assistant',
      threadId: THREAD_ID,
    },
  }])
  assert.deepEqual(published, [{
    data: {
      agentId: AGENT_ID,
      channelId: CHANNEL_ID,
      contentPreview: noticeInput.content,
      messageId: NOTICE_MESSAGE_ID,
      role: 'assistant',
      threadId: THREAD_ID,
    },
    event: 'message.new',
  }])
})

test('a replay of the same engagement decision does not duplicate its notice', async () => {
  const { creates, deps, published } = makeDeps(true)

  await postOrchestrationNotice(deps, noticeInput)

  assert.equal(creates.length, 0)
  assert.equal(published.length, 0)
})
