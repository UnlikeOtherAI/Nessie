import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createPersonalAssistantIntegrationHandoff } from '../src/services/integration-handoffs.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-000000000004'
const agentId = '00000000-0000-4000-8000-000000000005'
const channelId = '00000000-0000-4000-8000-000000000006'
const threadId = '00000000-0000-4000-8000-000000000007'
const messageId = '00000000-0000-4000-8000-000000000008'

const actorContext = {
  actionContext: { requestId: 'handoff-atomicity' },
  actor: { actorId: userId, actorType: 'user' as const, roles: ['member'] },
  tenant: { organizationId, projectId, teamId },
}

type HarnessOptions = {
  enqueueFails?: boolean
  realtimeFails?: boolean
}

const createHarness = (options: HarnessOptions = {}) => {
  const attempts: string[] = []
  const messages: string[] = []
  const attachments: string[] = []
  const queue: string[] = []
  const message = {
    agentId: null,
    content: 'Research safely',
    createdAt: new Date('2026-07-19T10:00:00.000Z'),
    deletedAt: null,
    editedAt: null,
    id: messageId,
    metadata: {},
    reactions: [],
    role: 'user',
    threadId,
    user: {
      avatarAttachmentId: null,
      avatarUrl: null,
      displayName: 'Researcher',
      email: 'researcher@example.com',
      id: userId,
    },
    userId,
  }
  const tx = {
    message: {
      create: async () => {
        attempts.push('message')
        messages.push(messageId)
        return message
      },
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) => {
      const snapshot = {
        attachments: attachments.length,
        messages: messages.length,
        queue: queue.length,
      }
      try {
        return await action(tx)
      } catch (error) {
        attachments.splice(snapshot.attachments)
        messages.splice(snapshot.messages)
        queue.splice(snapshot.queue)
        throw error
      }
    },
    agent: {
      findUnique: async () => ({
        id: agentId,
        name: 'Personal Assistant',
        role: 'assistant',
        systemPrompt: 'Help',
      }),
    },
  } as unknown as PrismaClient
  const deps = {
    buildChannelRealtimeScopes: () => [],
    enqueue: async () => {
      attempts.push('enqueue')
      if (options.enqueueFails) throw new Error('queue failed')
      queue.push(messageId)
      return true
    },
    ensureBootstrap: async () => ({ agentId, channelId, threadId }),
    isPersonalAssistantChannelType: (
      value: string | null | undefined,
    ): value is 'personal_assistant' => value === 'personal_assistant',
    loadPersonalAssistantState: async () => ({
      agent: { id: agentId },
      channel: {
        archivedAt: null,
        createdAt: '2026-07-19T10:00:00.000Z',
        defaultThreadId: threadId,
        dmUserId: userId,
        id: channelId,
        label: 'Personal Assistant',
        memberRole: 'member',
        organizationId,
        projectId,
        projectName: 'Project',
        slug: null,
        systemChannelType: 'personal_assistant',
        teamId,
        teamName: 'Team',
        topic: null,
        description: null,
        type: 'dm',
        unreadCount: 0,
        updatedAt: '2026-07-19T10:00:00.000Z',
        visibility: 'private',
      },
      thread: {
        channelId,
        createdAt: '2026-07-19T10:00:00.000Z',
        id: threadId,
        title: 'Default',
        updatedAt: '2026-07-19T10:00:00.000Z',
      },
    }),
    prisma,
    realtimeHub: {
      publishWs: async () => {
        attempts.push('realtime')
        if (options.realtimeFails) throw new Error('realtime failed')
      },
    },
  }

  const handoff = (beforeEnqueue: (context: { messageId: string }) => Promise<void>) =>
    createPersonalAssistantIntegrationHandoff(
      deps as never,
      {
        actorContext,
        beforeEnqueue: async (_tx, context) => beforeEnqueue(context),
        content: 'Research safely',
        metadata: {},
        teamId,
      },
    )

  return { attachments, attempts, handoff, messages, queue }
}

test('attachment failure rolls back the message before durable enqueue', async () => {
  const harness = createHarness()

  await assert.rejects(
    harness.handoff(async () => {
      harness.attempts.push('attach')
      throw new Error('attach failed')
    }),
    /attach failed/,
  )

  assert.deepEqual(harness.attempts, ['message', 'attach'])
  assert.deepEqual(harness.messages, [])
  assert.deepEqual(harness.attachments, [])
  assert.deepEqual(harness.queue, [])
})

test('enqueue failure rolls back both run attachment and message', async () => {
  const harness = createHarness({ enqueueFails: true })

  await assert.rejects(
    harness.handoff(async ({ messageId: attachedMessageId }) => {
      harness.attempts.push('attach')
      harness.attachments.push(attachedMessageId)
    }),
    /queue failed/,
  )

  assert.deepEqual(harness.attempts, ['message', 'attach', 'enqueue'])
  assert.deepEqual(harness.messages, [])
  assert.deepEqual(harness.attachments, [])
  assert.deepEqual(harness.queue, [])
})

test('realtime failure is non-fatal after message, attachment, and queue commit', async () => {
  const harness = createHarness({ realtimeFails: true })
  const originalConsoleError = console.error
  console.error = () => undefined

  try {
    const result = await harness.handoff(async ({ messageId: attachedMessageId }) => {
      harness.attempts.push('attach')
      harness.attachments.push(attachedMessageId)
    })

    assert.equal(result.message.id, messageId)
    assert.deepEqual(
      harness.attempts,
      ['message', 'attach', 'enqueue', 'realtime'],
    )
    assert.deepEqual(harness.messages, [messageId])
    assert.deepEqual(harness.attachments, [messageId])
    assert.deepEqual(harness.queue, [messageId])
  } finally {
    console.error = originalConsoleError
  }
})
