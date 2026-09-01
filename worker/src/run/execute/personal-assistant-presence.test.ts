import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createConsumedSourceSink } from './disclosure-basis.js'
import { createAgentMessage } from './agent-message.js'
import {
  assertPersonalAssistantPresenceRunPlacement,
  PersonalAssistantPresencePlacementError,
} from './personal-assistant-presence-placement.js'
import type { RunContext } from './types.js'

const id = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
const principalUserId = id('1')

const presenceContext = (): RunContext => ({
  agent: {
    agentKind: 'personal_assistant',
    effort: 'medium',
    executionMode: 'inference',
    id: id('2'),
    model: null,
    name: 'Personal Assistant',
    parentAgentId: null,
    provider: null,
    systemPrompt: null,
  },
  boundAgentIds: [],
  channel: {
    id: id('3'),
    organizationId: id('4'),
    projectId: id('5'),
    systemChannelType: null,
    teamId: id('6'),
  },
  consumedSources: createConsumedSourceSink(),
  run: {
    createdAt: new Date('2026-08-31T00:00:00.000Z'),
    id: id('7'),
    principalUserId,
    replyPlacement: null,
    threadId: id('8'),
    trigger: null,
  },
  task: { id: id('9') },
})

test('a PA presence refuses to run when its exact binding no longer exists', async () => {
  const context = presenceContext()
  const prisma = {
    agentBinding: { findFirst: async () => null },
    organizationMember: { findFirst: async () => ({ id: id('10') }) },
  } as unknown as PrismaClient

  await assert.rejects(
    () => assertPersonalAssistantPresenceRunPlacement(prisma, context),
    (error: unknown) => error instanceof PersonalAssistantPresencePlacementError,
  )
})

test('a PA presence run stamps each reply with its principal', async () => {
  const context = presenceContext()
  let messageData: Record<string, unknown> | undefined
  const transaction = {
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        messageData = data
        return {
          id: id('11'),
          createdAt: new Date('2026-08-31T00:00:00.000Z'),
          threadId: context.run.threadId,
          content: 'Reply',
          role: 'assistant',
        }
      },
    },
    messageBasisScope: { createMany: async () => ({ count: 0 }) },
    runBasisScope: { createMany: async () => ({ count: 0 }) },
  }
  const prisma = {
    $transaction: async <T>(work: (tx: typeof transaction) => Promise<T>) => work(transaction),
  } as unknown as PrismaClient

  await createAgentMessage(prisma, context, {
    agentId: context.agent.id,
    content: 'Reply',
    role: 'assistant',
    threadId: context.run.threadId,
  })

  assert.equal(messageData?.onBehalfOfUserId, principalUserId)
})
