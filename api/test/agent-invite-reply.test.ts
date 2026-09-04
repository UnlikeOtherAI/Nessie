import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AgentRecord, AuthorizedActionContext, OrchestrateDecideJobPayload } from '@nessie/schemas'
import { enqueueInvitedAgentMentionReplay } from '../src/services/agent-invite-reply.js'

const agentId = '00000000-0000-4000-8000-000000000001'
const channelId = '00000000-0000-4000-8000-000000000002'
const messageId = '00000000-0000-4000-8000-000000000003'
const organizationId = '00000000-0000-4000-8000-000000000004'
const threadId = '00000000-0000-4000-8000-000000000005'
const userId = '00000000-0000-4000-8000-000000000006'

const actorContext = {
  actionContext: { requestId: 'request-1' },
  actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
  tenant: { organizationId },
} as unknown as AuthorizedActionContext

const agent = {
  id: agentId,
  name: 'Hardware Watch',
  role: 'monitor',
  systemPrompt: 'Report hardware status.',
} as AgentRecord

const input = {
  actorContext,
  agent,
  channelId,
  messageId,
  organizationId,
}

test('replays the exact pending mention after its agent is invited', async () => {
  let messageWhere: unknown
  let queued: OrchestrateDecideJobPayload | undefined
  let idempotencyKey: string | undefined
  const prisma = {
    message: {
      findFirst: async ({ where }: { where: unknown }) => {
        messageWhere = where
        return {
          content: '@Hardware Watch\u00a0all good?',
          id: messageId,
          role: 'user',
          threadId,
        }
      },
    },
  } as unknown as Pick<PrismaClient, '$executeRaw' | 'message'>

  const queuedResult = await enqueueInvitedAgentMentionReplay(
    prisma,
    input,
    async (_prisma, payload, key) => {
      queued = payload
      idempotencyKey = key
      return true
    },
  )

  assert.equal(queuedResult, true)
  assert.deepEqual(messageWhere, {
    deletedAt: null,
    id: messageId,
    role: 'user',
    thread: { channelId, channel: { organizationId } },
    userId,
  })
  assert.deepEqual(queued?.channelAgents, [{
    id: agentId,
    name: 'Hardware Watch',
    role: 'monitor',
    systemPrompt: 'Report hardware status.',
  }])
  assert.deepEqual(queued?.agentMentions, [{ agentId, type: 'agent' }])
  assert.equal(queued?.content, '@Hardware Watch\u00a0all good?')
  assert.equal(queued?.messageId, messageId)
  assert.equal(queued?.threadId, threadId)
  assert.equal(idempotencyKey, `orchestrate:invite:${messageId}:${agentId}`)
})

test('does not replay a different same-named agent when structured metadata names another id', async () => {
  let enqueueCalls = 0
  const prisma = {
    message: {
      findFirst: async () => ({
        content: '@Hardware Watch all good?',
        id: messageId,
        metadata: {
          mentions: {
            agentMentions: [{
              agentId: '00000000-0000-4000-8000-000000000099',
              type: 'agent',
            }],
          },
        },
        role: 'user',
        threadId,
      }),
    },
  } as unknown as Pick<PrismaClient, '$executeRaw' | 'message'>

  const queuedResult = await enqueueInvitedAgentMentionReplay(
    prisma,
    input,
    async () => {
      enqueueCalls += 1
      return true
    },
  )

  assert.equal(queuedResult, false)
  assert.equal(enqueueCalls, 0)
})

test('refuses to replay an arbitrary message after an invitation', async () => {
  let enqueueCalls = 0
  const prisma = {
    message: {
      findFirst: async () => ({
        content: 'Oi',
        id: messageId,
        role: 'user',
        threadId,
      }),
    },
  } as unknown as Pick<PrismaClient, '$executeRaw' | 'message'>

  const queuedResult = await enqueueInvitedAgentMentionReplay(
    prisma,
    input,
    async () => {
      enqueueCalls += 1
      return true
    },
  )

  assert.equal(queuedResult, false)
  assert.equal(enqueueCalls, 0)
})
