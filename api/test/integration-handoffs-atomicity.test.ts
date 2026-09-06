import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { RunExecuteJobPayload } from '@nessie/schemas'

import { createPersonalAssistantIntegrationHandoff } from '../src/services/integration-handoffs.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-000000000004'
const agentId = '00000000-0000-4000-8000-000000000005'
const channelId = '00000000-0000-4000-8000-000000000006'
const threadId = '00000000-0000-4000-8000-000000000007'
const messageId = '00000000-0000-4000-8000-000000000008'
const runId = '00000000-0000-4000-8000-000000000009'
const taskId = '00000000-0000-4000-8000-000000000010'

const actorContext = {
  actionContext: { requestId: 'handoff-atomicity' },
  actor: { actorId: userId, actorType: 'user' as const, roles: ['member'] },
  tenant: { organizationId, projectId, teamId },
}

type HarnessOptions = {
  enqueueFails?: boolean
  enqueueReturnsFalse?: boolean
  realtimeFails?: boolean
}

const createHarness = (options: HarnessOptions = {}) => {
  const attempts: string[] = []
  const attachments: string[] = []
  const messages: string[] = []
  const queue: Array<{ key: string | undefined; payload: RunExecuteJobPayload }> = []
  const runs: string[] = []
  const tasks: string[] = []
  const message = {
    agentId: null,
    content: 'Migrate @MainActor safely',
    createdAt: new Date('2026-07-19T10:00:00.000Z'),
    deletedAt: null,
    editedAt: null,
    id: messageId,
    metadata: {},
    basisScopes: [],
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
    // A system-authored message follows its requester in the same
    // transaction (`followReplyThread`), so the fake must model the follow row.
    messageThreadFollow: {
      createMany: async () => ({ count: 1 }),
    },
    run: {
      create: async () => {
        attempts.push('run')
        runs.push(runId)
        return { agentId, id: runId, threadId }
      },
    },
    task: {
      create: async () => {
        attempts.push('task')
        tasks.push(taskId)
        return { id: taskId }
      },
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) => {
      const snapshot = {
        attachments: attachments.length,
        messages: messages.length,
        queue: queue.length,
        runs: runs.length,
        tasks: tasks.length,
      }
      try {
        return await action(tx)
      } catch (error) {
        attachments.splice(snapshot.attachments)
        messages.splice(snapshot.messages)
        queue.splice(snapshot.queue)
        runs.splice(snapshot.runs)
        tasks.splice(snapshot.tasks)
        throw error
      }
    },
    agent: {
      findUnique: async () => ({ id: agentId }),
    },
  } as unknown as PrismaClient
  const deps = {
    buildChannelRealtimeScopes: () => [],
    enqueue: async (
      _tx: unknown,
      payload: RunExecuteJobPayload,
      key?: string,
    ) => {
      attempts.push('enqueue')
      if (options.enqueueFails) throw new Error('queue failed')
      if (options.enqueueReturnsFalse || queue.some((job) => job.key === key)) {
        return false
      }
      queue.push({ key, payload })
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
        description: null,
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
        type: 'dm',
        unreadCount: 0,
        lastMessageAt: null,
        // A system channel is never manageable: `canManageChannel` refuses
        // every viewer on one, so the record carries the decision, not a guess.
        viewerCanManage: false,
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

  const handoff = (
    beforeEnqueue: (context: { messageId: string }) => Promise<void>,
  ) =>
    createPersonalAssistantIntegrationHandoff(
      deps as never,
      {
        actorContext,
        beforeEnqueue: async (_tx, context) => beforeEnqueue(context),
        content: message.content,
        metadata: {},
        teamId,
      },
    )

  return {
    attachments,
    attempts,
    handoff,
    messages,
    queue,
    runs,
    tasks,
  }
}

test('attachment failure rolls back the message before run dispatch', async () => {
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
  assert.deepEqual(harness.runs, [])
  assert.deepEqual(harness.tasks, [])
  assert.deepEqual(harness.queue, [])
})

test('enqueue failure rolls back attachment, message, run, and task', async () => {
  const harness = createHarness({ enqueueFails: true })

  await assert.rejects(
    harness.handoff(async ({ messageId: attachedMessageId }) => {
      harness.attempts.push('attach')
      harness.attachments.push(attachedMessageId)
    }),
    /queue failed/,
  )

  assert.deepEqual(
    harness.attempts,
    ['message', 'attach', 'run', 'task', 'enqueue'],
  )
  assert.deepEqual(harness.messages, [])
  assert.deepEqual(harness.attachments, [])
  assert.deepEqual(harness.runs, [])
  assert.deepEqual(harness.tasks, [])
  assert.deepEqual(harness.queue, [])
})

test('a duplicate enqueue cannot commit an orphaned PA run', async () => {
  const harness = createHarness({ enqueueReturnsFalse: true })

  await assert.rejects(
    harness.handoff(async ({ messageId: attachedMessageId }) => {
      harness.attempts.push('attach')
      harness.attachments.push(attachedMessageId)
    }),
    /already dispatched/,
  )

  assert.deepEqual(harness.messages, [])
  assert.deepEqual(harness.attachments, [])
  assert.deepEqual(harness.runs, [])
  assert.deepEqual(harness.tasks, [])
  assert.deepEqual(harness.queue, [])
})

test('@-prefixed research text dispatches directly without engagement decisions', async () => {
  const harness = createHarness()

  await harness.handoff(async ({ messageId: attachedMessageId }) => {
    harness.attempts.push('attach')
    harness.attachments.push(attachedMessageId)
  })

  assert.deepEqual(harness.runs, [runId])
  assert.deepEqual(harness.tasks, [taskId])
  assert.equal(harness.queue.length, 1)
  assert.deepEqual(harness.queue[0]?.payload, {
    actorContext: {
      ...actorContext,
      actionContext: {
        ...actorContext.actionContext,
        agentId,
        channelId,
        effectiveUserId: userId,
        taskId,
        threadId,
      },
    },
    agentId,
    interactive: true,
    messageId,
    runId,
    taskId,
    threadId,
  })
})

test('realtime failure is non-fatal after the durable run dispatch commits', async () => {
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
      ['message', 'attach', 'run', 'task', 'enqueue', 'realtime'],
    )
    assert.deepEqual(harness.messages, [messageId])
    assert.deepEqual(harness.attachments, [messageId])
    assert.deepEqual(harness.runs, [runId])
    assert.deepEqual(harness.tasks, [taskId])
    assert.equal(harness.queue.length, 1)
  } finally {
    console.error = originalConsoleError
  }
})
