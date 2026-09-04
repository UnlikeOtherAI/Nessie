import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { sealSecret } from '@nessie/comms-connect'

import {
  mailboxSendExecutionId,
  runMailboxSendTool,
} from '../src/run/pa-tools/mailbox-tools.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const ids = {
  agent: '00000000-0000-4000-8000-000000000201',
  channel: '00000000-0000-4000-8000-000000000202',
  connection: '00000000-0000-4000-8000-000000000203',
  owner: '00000000-0000-4000-8000-000000000204',
  organization: '00000000-0000-4000-8000-000000000205',
}

const runId = '00000000-0000-4000-8000-000000000206'
const toolCallId = 'provider-call:durable-1'

const connection = {
  address: 'support@example.test',
  createdAt: new Date('2026-09-04T00:00:00Z'),
  createdByUserId: ids.owner,
  id: ids.connection,
  imapHost: '127.0.0.1',
  imapPort: 1,
  imapSecurity: 'tls',
  label: 'Support',
  lastVerifiedAt: null,
  organizationId: ids.organization,
  ownerUserId: null,
  smtpHost: '127.0.0.1',
  smtpPort: 1,
  smtpSecurity: 'tls',
  status: 'active',
  statusReason: null,
  teamId: '00000000-0000-4000-8000-000000000207',
  updatedAt: new Date('2026-09-04T00:00:00Z'),
  username: 'support@example.test',
}

const buildContext = (prisma: PrismaClient): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { effectiveUserId: null, requestId: 'request-1' },
    actor: { actorId: ids.agent, actorType: 'agent' },
    tenant: { organizationId: ids.organization },
  },
  agentId: ids.agent,
  agentKind: 'shared',
  channel: { id: ids.channel, organizationId: ids.organization, systemChannelType: null },
  ledgerIdentity: null,
  prisma,
  realtimeTransport: {} as never,
  run: { id: runId, messageId: 'message-1', threadId: 'thread-1' },
  toolCallId,
})

test('agent mailbox_send replays one stable Message-ID and never resends an ambiguous SMTP outcome', async () => {
  let action: Record<string, unknown> | undefined
  let credentialReads = 0
  const creates: Record<string, unknown>[] = []
  const prisma = {
    mailboxConnection: { findMany: async () => [connection] },
    mailboxConnectionCredential: {
      findUnique: async () => {
        credentialReads += 1
        return { secretCiphertext: sealSecret('test-secret', 'password') }
      },
    },
    mailboxSendAction: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        creates.push(create)
        action ??= { ...create, state: 'ready' }
        return action
      },
      update: async () => action,
      updateMany: async ({ data, where }: { data: Record<string, unknown>; where: { state?: string } }) => {
        if (action?.state !== where.state) return { count: 0 }
        action = { ...action, ...data }
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient
  const previousSecret = process.env.NESSIE_AUTH_SECRET
  process.env.NESSIE_AUTH_SECRET = 'test-secret'
  try {
    const send = () => runMailboxSendTool(buildContext(prisma), {
      subject: 'Status', text: 'Hello', to: ['recipient@example.test'],
    })
    await assert.rejects(send, /delivery unknown/)
    const firstMessageId = action?.messageId
    await assert.rejects(send, /delivery unknown/)
    assert.equal(action?.state, 'delivery_unknown')
    assert.equal(action?.messageId, firstMessageId)
    assert.equal(credentialReads, 1, 'the delivery_unknown replay returns before credentials are read')
    assert.equal(creates[0]?.clientRequestId, mailboxSendExecutionId(runId, toolCallId))
    assert.equal(creates[1]?.clientRequestId, mailboxSendExecutionId(runId, toolCallId))
    assert.match(String(firstMessageId), /^nessie-[0-9a-f-]+@example\.test$/)
  } finally {
    if (previousSecret === undefined) delete process.env.NESSIE_AUTH_SECRET
    else process.env.NESSIE_AUTH_SECRET = previousSecret
  }
})

test('the mailbox-send execution identity is stable per run and tool call', () => {
  const first = mailboxSendExecutionId(runId, toolCallId)
  assert.equal(first, mailboxSendExecutionId(runId, toolCallId))
  assert.notEqual(first, mailboxSendExecutionId(runId, 'provider-call:durable-2'))
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
