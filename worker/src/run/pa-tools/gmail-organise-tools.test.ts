import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOrganizationId } from '@nessie/schemas'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import {
  runGmailLabelsListTool,
  runGmailOrganiseTool,
} from './gmail-organise-tools.js'

const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'

const makeContext = (
  prisma: Record<string, unknown> = {},
  effectiveUserId: string | null = USER,
) => {
  const consumed: Array<{ scopeId: string; scopeType: string }> = []
  const context = {
    agentId: 'agent-1',
    agentKind: 'personal_assistant',
    actorContext: {
      actor: {
        actorId: USER,
        actorType: effectiveUserId ? 'user' : 'agent',
        roles: [],
      },
      actionContext: { effectiveUserId, purpose: 'chat', requestId: 'test' },
      tenant: { organizationId: parseOrganizationId(ORGANIZATION) },
    },
    channel: { id: 'channel-1', organizationId: parseOrganizationId(ORGANIZATION) },
    consumedSources: { add: (source: { scopeId: string; scopeType: string }) => consumed.push(source) },
    prisma,
    realtimeTransport: {},
    run: { id: 'run-1', messageId: 'message-1', threadId: 'thread-1' },
    toolCallId: null,
  } as unknown as BuiltinToolRuntimeContext
  return { consumed, context }
}

const credential = {
  credential: { accessToken: 'access-token' },
  externalUserId: 'person@example.com',
  ownerUserId: USER,
}

test('lists labels through gmail.read and records the mailbox owner', async () => {
  const { consumed, context } = makeContext()
  const capabilities: string[] = []
  const dependencies: NonNullable<Parameters<typeof runGmailLabelsListTool>[2]> = {
    credentialFor: async (_context, capabilityId) => {
      capabilities.push(capabilityId)
      return credential as never
    },
    listGmailLabels: async (_fetch, token) => {
      assert.equal(token, 'access-token')
      return [{ id: 'Label_123', name: 'Receipts', type: 'user' }]
    },
  }

  const result = await runGmailLabelsListTool(context, {}, dependencies)

  assert.deepEqual(capabilities, ['gmail.read'])
  assert.deepEqual(consumed, [{ scopeId: USER, scopeType: 'user' }])
  assert.match(result.outputPreview, /Receipts/)
})

test('applies labels and archives through one gmail.modify mutation', async () => {
  const { consumed, context } = makeContext()
  const calls: Array<{ addLabelIds?: string[]; removeLabelIds?: string[]; threadId: string }> = []
  const capabilities: string[] = []
  const dependencies: NonNullable<Parameters<typeof runGmailOrganiseTool>[2]> = {
    credentialFor: async (_context, capabilityId, userId) => {
      capabilities.push(capabilityId)
      assert.equal(userId, USER)
      return credential as never
    },
    modifyGmailThread: async (_fetch, token, input) => {
      assert.equal(token, 'access-token')
      calls.push(input)
    },
  }

  const result = await runGmailOrganiseTool(context, {
    addLabelIds: ['STARRED'],
    archive: true,
    removeLabelIds: ['Label_123'],
    threadId: 'thread-123',
  }, dependencies)

  assert.deepEqual(capabilities, ['gmail.modify'])
  assert.deepEqual(calls, [{
    addLabelIds: ['STARRED'],
    removeLabelIds: ['Label_123', 'INBOX'],
    threadId: 'thread-123',
  }])
  assert.deepEqual(consumed, [{ scopeId: USER, scopeType: 'user' }])
  assert.equal(result.outputPreview, JSON.stringify({
    threadId: 'thread-123',
    applied: ['STARRED'],
    removed: ['Label_123', 'INBOX'],
    trashed: false,
  }))
})

test('restores INBOX when unarchiving', async () => {
  const { context } = makeContext()
  let mutation: { addLabelIds?: string[]; removeLabelIds?: string[]; threadId: string } | undefined

  await runGmailOrganiseTool(context, { archive: false, threadId: 'thread-123' }, {
    credentialFor: async () => credential as never,
    modifyGmailThread: async (_fetch, _token, input) => { mutation = input },
  })

  assert.deepEqual(mutation, {
    addLabelIds: ['INBOX'],
    removeLabelIds: [],
    threadId: 'thread-123',
  })
})

test('refuses a gmail.read-only connection and requests gmail.modify', async () => {
  process.env.NESSIE_AUTH_SECRET = 'gmail-organise-test-secret'
  let credentialQuery: Record<string, unknown> | undefined
  const { consumed, context } = makeContext({
    commsConnection: {
      findMany: async (input: { where: Record<string, unknown>; select: unknown }) => {
        credentialQuery = input.where
        return [{
          disabledCapabilities: [],
          grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          id: 'connection-1',
          status: 'active',
        }]
      },
    },
    thread: { findUnique: async () => null },
  })

  await assert.rejects(
    runGmailOrganiseTool(context, { archive: true, threadId: 'thread-123' }),
    /permission to organise your email/i,
  )

  assert.deepEqual(credentialQuery, {
    organizationId: ORGANIZATION,
    ownerUserId: USER,
    provider: 'google',
    status: { not: 'disconnected' },
  })
  assert.deepEqual(consumed, [{ scopeId: USER, scopeType: 'user' }])
})

test('does not call Gmail for a run without an acting mailbox owner', async () => {
  const { context } = makeContext({}, null)
  let called = false

  await assert.rejects(
    runGmailOrganiseTool(context, { archive: true, threadId: 'thread-123' }, {
      credentialFor: async () => {
        called = true
        return credential as never
      },
    }),
    /only reach your Google account when a person asks/i,
  )
  assert.equal(called, false)
})

test('preserves a Gmail provider failure instead of reporting success', async () => {
  const { context } = makeContext()

  await assert.rejects(
    runGmailOrganiseTool(context, { archive: true, threadId: 'thread-123' }, {
      credentialFor: async () => credential as never,
      modifyGmailThread: async () => { throw new Error('Google rejected labels') },
    }),
    /Google rejected labels/,
  )
})
