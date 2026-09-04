import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'

import { recordToolEnd } from './tool-events.js'
import type { ExecutionDependencies, RunContext } from './types.js'

test('tool completion redacts before bounding its durable preview', async () => {
  let stored: Record<string, unknown> | undefined
  const deps = {
    prisma: {
      toolCall: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          stored = data
          return {}
        },
      },
    },
    realtimeTransport: { publishWs: async () => undefined },
  } as unknown as ExecutionDependencies
  const context = {
    activeDemonstrationId: null,
    agent: {
      agentKind: 'shared',
      id: '10000000-0000-4000-8000-000000000001',
      systemSlug: null,
    },
    channel: {
      dmKey: null,
      id: '10000000-0000-4000-8000-000000000002',
      organizationId: '10000000-0000-4000-8000-000000000003',
      systemChannelType: null,
    },
    run: {
      id: '10000000-0000-4000-8000-000000000004',
      threadId: '10000000-0000-4000-8000-000000000005',
    },
  } as unknown as RunContext
  const actorContext = {} as AuthorizedActionContext
  const token = ['sk', 'proj', 'abcdefghijklmnopqrstuv'].join('-')

  await recordToolEnd(deps, context, actorContext, {
    argumentsValue: {},
    durationMs: 1,
    inputSummary: 'safe',
    outputPreview: `${'x'.repeat(1189)} ${token}`,
    startedAt: new Date(),
    success: true,
    toolName: 'internal_test_tool',
  })

  const preview = String(stored?.['outputPreview'])
  assert.equal(preview.length, 1200)
  assert.doesNotMatch(preview, /abcdefghijklmnopqrstuv/)
  assert.match(preview, /sk-proj-•+$/)
})

const ids = {
  agent: '10000000-0000-4000-8000-000000000001',
  channel: '10000000-0000-4000-8000-000000000002',
  organization: '10000000-0000-4000-8000-000000000003',
  run: '10000000-0000-4000-8000-000000000004',
  task: '10000000-0000-4000-8000-000000000005',
  thread: '10000000-0000-4000-8000-000000000006',
  user: '10000000-0000-4000-8000-000000000007',
} as const

const context = (): RunContext => ({
  agent: { id: ids.agent },
  boundAgentIds: [],
  channel: {
    id: ids.channel,
    organizationId: ids.organization,
    projectId: null,
    systemChannelType: null,
    teamId: null,
  },
  run: { id: ids.run, threadId: ids.thread },
  task: { id: ids.task },
}) as unknown as RunContext

const actorContext = (): AuthorizedActionContext => ({
  actionContext: { requestId: 'email-privacy-test' },
  actor: { actorId: ids.user, actorType: 'user', roles: [] },
  tenant: { organizationId: ids.organization },
}) as unknown as AuthorizedActionContext

test('mail and account tools store content-free tool and connector telemetry', async () => {
  const toolCalls: Array<Record<string, unknown>> = []
  const connectorEvents: Array<Record<string, unknown>> = []
  const prisma = {
    connectorUsageEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        connectorEvents.push(data)
        return {}
      },
    },
    toolCall: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        toolCalls.push(data)
        return {}
      },
    },
  }
  const deps = {
    prisma,
    realtimeTransport: { publishWs: async () => undefined },
  } as unknown as ExecutionDependencies
  const correspondence = {
    body: 'Please include this private body.',
    connectionId: '20000000-0000-4000-8000-000000000001',
    subject: 'Private renewal terms',
    to: ['recipient@example.test'],
  }

  await recordToolEnd(deps, context(), actorContext(), {
    argumentsValue: correspondence,
    connectorUsage: {
      calls: 1,
      connectorType: 'email',
      metadata: { host: 'imap.private.example.test' },
      operation: 'send',
      target: 'sender@example.test',
    },
    durationMs: 10,
    inputSummary: JSON.stringify(correspondence),
    outputPreview: 'Sent from sender@example.test to recipient@example.test: Private renewal terms.',
    startedAt: new Date(),
    success: true,
    toolName: 'mailbox_send',
  })

  await recordToolEnd(deps, context(), actorContext(), {
    argumentsValue: { query: 'from:sender@example.test subject:private' },
    durationMs: 11,
    inputSummary: 'query=from:sender@example.test subject:private',
    outputPreview: 'sender@example.test wrote about private terms',
    startedAt: new Date(),
    success: true,
    toolName: 'gmail_search',
  })

  await recordToolEnd(deps, context(), actorContext(), {
    argumentsValue: { oauthCode: 'code-for-owner@example.test' },
    durationMs: 12,
    inputSummary: 'oauthCode=code-for-owner@example.test',
    outputPreview: 'Provider rejected owner@example.test at oauth.example.test',
    startedAt: new Date(),
    success: false,
    toolName: 'email_account_connect',
  })

  const persisted = JSON.stringify({ connectorEvents, toolCalls })
  assert.doesNotMatch(persisted, new RegExp([
    'recipient@example\\.test', 'sender@example\\.test', 'owner@example\\.test',
    'Private renewal', 'private body', 'imap\\.private', 'oauth\\.example',
  ].join('|')))
  assert.deepEqual(
    toolCalls.map((entry) => [entry.inputSummary, entry.outputPreview]),
    [
      ['Send from a connected mailbox.', 'Email send completed.'],
      ['Search Gmail.', 'Email action completed.'],
      ['Manage a connected email account.', 'Email action did not complete.'],
    ],
  )
  assert.equal(connectorEvents[0]?.target, null)
  assert.equal(connectorEvents[0]?.metadata, undefined)
  assert.equal(connectorEvents[0]?.operation, 'email_action')
})
