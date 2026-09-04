import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  runEmailAccountCheckTool,
  runEmailAccountListTool,
} from '../src/run/pa-tools/email-accounts.js'
import { runEmailAccountConnectTool } from '../src/run/pa-tools/comms-card.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const ids = {
  agent: '00000000-0000-4000-8000-000000000001',
  channel: '00000000-0000-4000-8000-000000000002',
  google: '00000000-0000-4000-8000-000000000003',
  mailbox: '00000000-0000-4000-8000-000000000004',
  microsoft: '00000000-0000-4000-8000-000000000005',
  organization: '00000000-0000-4000-8000-000000000006',
  slack: '00000000-0000-4000-8000-000000000007',
  user: '00000000-0000-4000-8000-000000000008',
  thread: '00000000-0000-4000-8000-000000000009',
  message: '00000000-0000-4000-8000-000000000010',
}

const connection = (
  id: string,
  provider: 'google' | 'microsoft' | 'slack',
  externalUserId: string,
) => ({
  createdAt: new Date('2026-09-01T00:00:00Z'),
  disabledCapabilities: [],
  externalTenantId: 'tenant',
  externalUserId,
  grantedScopes: [],
  id,
  initialSyncCompletedAt: new Date('2026-09-02T00:00:00Z'),
  lastSuccessfulSyncAt: new Date('2026-09-03T00:00:00Z'),
  organizationId: ids.organization,
  ownerUserId: ids.user,
  provider,
  providerAccountId: null,
  requestedCapabilities: [],
  status: 'active',
  updatedAt: new Date('2026-09-03T00:00:00Z'),
})

const buildPrisma = (overrides: Record<string, unknown> = {}) => ({
  organizationMember: {
    findUnique: async () => ({ deactivatedAt: null, role: 'member' }),
  },
  commsConnection: {
    findFirst: async () => connection(ids.slack, 'slack', 'workspace'),
    findMany: async () => [
      connection(ids.google, 'google', 'me@example.com'),
      connection(ids.slack, 'slack', 'workspace'),
      connection(ids.microsoft, 'microsoft', 'me@work.example'),
    ],
  },
  commsResource: {
    groupBy: async (input: { where: { syncEnabled?: boolean } }) =>
      input.where.syncEnabled
        ? [{ connectionId: ids.google, _count: { _all: 2 } }]
        : [{ connectionId: ids.google, _count: { _all: 3 } }],
  },
  teamMember: { findMany: async () => [] },
  mailboxConnection: {
    findMany: async () => [{
      address: 'support@example.com',
      agentAccess: [{ agentId: ids.agent }],
      createdAt: new Date('2026-09-01T00:00:00Z'),
      createdByUserId: ids.user,
      id: ids.mailbox,
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecurity: 'tls',
      label: 'Support',
      lastVerifiedAt: new Date('2026-09-03T00:00:00Z'),
      organizationId: ids.organization,
      ownerUserId: ids.user,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      status: 'active',
      statusReason: null,
      teamId: null,
      updatedAt: new Date('2026-09-03T00:00:00Z'),
      username: 'support@example.com',
    }],
  },
  ...overrides,
}) as unknown as PrismaClient

const buildContext = (prisma: PrismaClient): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { effectiveUserId: ids.user, requestId: 'request-1' },
    actor: { actorId: ids.agent, actorType: 'agent' },
    tenant: { organizationId: ids.organization },
  },
  agentId: ids.agent,
  agentKind: 'personal_assistant',
  channel: {
    id: ids.channel,
    organizationId: ids.organization,
    systemChannelType: 'personal_assistant',
  },
  ledgerIdentity: null,
  prisma,
  realtimeTransport: {} as never,
  run: { id: 'run-1', messageId: ids.message, threadId: ids.thread },
  toolCallId: 'call-1',
})

test('account listing combines email providers and mailboxes but excludes Slack', async () => {
  const result = await runEmailAccountListTool(buildContext(buildPrisma()))
  assert.match(result.outputPreview, /Google \| me@example\.com/)
  assert.match(result.outputPreview, /Microsoft \| me@work\.example/)
  assert.match(result.outputPreview, /Support \| support@example\.com/)
  assert.match(result.outputPreview, new RegExp(`accountId=${ids.google}`))
  assert.match(result.outputPreview, new RegExp(`accountId=${ids.mailbox}`))
  assert.doesNotMatch(result.outputPreview, /workspace|Slack/)
  assert.doesNotMatch(result.outputPreview, /imap\.example\.com|smtp\.example\.com|username/)
})

test('a Slack id is refused before an email-account check queues any work', async () => {
  let queueTouched = false
  const prisma = buildPrisma({
    $executeRaw: async () => {
      queueTouched = true
      return 1
    },
  })
  await assert.rejects(
    runEmailAccountCheckTool(buildContext(prisma), {
      accountId: ids.slack,
      accountKind: 'provider',
    }),
    /not an email account/,
  )
  assert.equal(queueTouched, false)
})

test('connect posts only a scoped doorway card, never connection secrets', async () => {
  let metadata: unknown
  let published = false
  const prisma = buildPrisma({
    message: {
      create: async (input: { data: { metadata: unknown } }) => {
        metadata = input.data.metadata
        return { id: ids.message }
      },
    },
    thread: {
      findUnique: async () => ({
        channel: { id: ids.channel, systemChannelType: 'personal_assistant' },
      }),
    },
  })
  const context = buildContext(prisma)
  context.realtimeTransport = {
    publishWs: async () => {
      published = true
    },
  } as never

  const result = await runEmailAccountConnectTool(context, { scope: 'team' })
  assert.deepEqual(metadata, {
    card: { kind: 'email_account_connect', scope: 'team' },
  })
  assert.doesNotMatch(JSON.stringify(metadata), /password|oauth|imap|smtp/i)
  assert.equal(published, true)
  assert.match(result.outputPreview, /Presented the secure connection form/)
})
