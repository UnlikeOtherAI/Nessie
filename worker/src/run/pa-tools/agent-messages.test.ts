import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runReactTool } from './agent-messages.js'

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000002'
const VIEWER_ID = '00000000-0000-4000-8000-000000000003'
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000004'

const makeContext = (basisScopes: Array<{ scopeId: string; scopeType: string }>) => {
  const createdReactions: unknown[] = []
  const context = {
    agentId: '00000000-0000-4000-8000-000000000005',
    agentKind: 'shared',
    actorContext: {
      actionContext: { effectiveUserId: VIEWER_ID },
      actor: { actorId: VIEWER_ID, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: ORGANIZATION_ID },
    },
    channel: {
      id: CHANNEL_ID,
      organizationId: ORGANIZATION_ID,
      systemChannelType: null,
      visibility: 'private',
    },
    memoryCaptureConfig: {
      pool: {
        query: async (sql: string) => {
          if (sql.includes('FROM channels c')) {
            return { rowCount: 1, rows: [{ id: CHANNEL_ID, projectId: null, teamId: null }] }
          }
          if (sql.includes('FROM agents')) {
            return { rowCount: 1, rows: [{ projectId: null, teamId: null }] }
          }
          if (sql.includes('FROM organization_members')) {
            return { rowCount: 1, rows: [{}] }
          }
          return { rowCount: 0, rows: [] }
        },
      },
    },
    prisma: {
      agent: { findMany: async () => [] },
      // The message is in a private channel. A disclosure grant cannot use the
      // public-channel audience exception for this fixture.
      channel: { findFirst: async () => null, findMany: async () => [] },
      channelMember: { findMany: async () => [] },
      disclosureGrant: { findMany: async () => [] },
      message: {
        findFirst: async () => ({
          agentId: '00000000-0000-4000-8000-000000000006',
          basisScopes,
          id: '00000000-0000-4000-8000-000000000007',
          thread: { channelId: CHANNEL_ID },
          threadId: '00000000-0000-4000-8000-000000000008',
        }),
      },
      messageReaction: {
        createMany: async ({ data }: { data: unknown[] }) => {
          createdReactions.push(...data)
          return { count: data.length }
        },
        deleteMany: async () => ({ count: 0 }),
      },
      organization: { findUnique: async () => ({ externalOrgId: null }) },
      organizationMember: { findFirst: async () => ({ id: 'membership' }) },
      productAccountLink: { findUnique: async () => null },
      projectMember: { findMany: async () => [] },
      scopeDisclosureGrant: { findMany: async () => [] },
      teamMember: { findMany: async () => [] },
    },
    realtimeTransport: {},
    run: {
      id: '00000000-0000-4000-8000-000000000009',
      messageId: '00000000-0000-4000-8000-000000000010',
      threadId: '00000000-0000-4000-8000-000000000008',
    },
  } as unknown as BuiltinToolRuntimeContext
  return { context, createdReactions }
}

test('react refuses a basis-restricted message despite accessible channel reach', async () => {
  const { context, createdReactions } = makeContext([
    { scopeId: OTHER_USER_ID, scopeType: 'user' },
  ])

  await assert.rejects(
    () => runReactTool(context, { emoji: '👀', messageId: '00000000-0000-4000-8000-000000000007' }),
    /Message not found in a conversation this agent can see/,
  )
  assert.deepEqual(createdReactions, [])
})

test('react preserves the unrestricted message outcome', async () => {
  const { context, createdReactions } = makeContext([])

  const result = await runReactTool(context, {
    emoji: '👀',
    messageId: '00000000-0000-4000-8000-000000000007',
  })

  assert.equal(result.toolName, 'react')
  assert.equal(createdReactions.length, 1)
})
