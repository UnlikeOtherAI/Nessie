import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { sealSecret } from '@nessie/comms-connect'

import {
  ConnectedMailError,
  listConnectedMailAccounts,
  listConnectedMailThreads,
} from '../src/connected-mail.js'
import {
  readMailboxSendAction,
  resolveStaleMailboxSendDispatches,
  sendConnectedMailboxMail,
} from '../src/mailbox-send-actions.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

test('account listing asks only for the person’s own Google and live team mailbox rows', async () => {
  const seen: unknown[] = []
  const prisma = {
    commsConnection: { findMany: async (args: unknown) => {
      seen.push(args)
      return []
    } },
    mailboxConnection: { findMany: async (args: unknown) => {
      seen.push(args)
      return []
    } },
  } as unknown as PrismaClient
  assert.deepEqual(await listConnectedMailAccounts(prisma, {
    organizationId: ORGANIZATION_ID, userId: USER_ID,
  }), [])
  assert.match(JSON.stringify(seen[0]), new RegExp(`"ownerUserId":"${USER_ID}"`))
  assert.match(JSON.stringify(seen[0]), new RegExp(`"organizationId":"${ORGANIZATION_ID}"`))
  assert.match(JSON.stringify(seen[1]), new RegExp(`"members":\{"some":\{"userId":"${USER_ID}"`))
})

test('account listing classifies non-active mailbox credentials without exposing an unknown state', async () => {
  const prisma = {
    commsConnection: { findMany: async () => [] },
    mailboxConnection: { findMany: async () => [{
      address: 'support@example.test', id: CONNECTION_ID, label: 'Support', ownerUserId: null,
      status: 'disabled',
    }] },
  } as unknown as PrismaClient
  const accounts = await listConnectedMailAccounts(prisma, {
    organizationId: ORGANIZATION_ID, userId: USER_ID,
  })
  assert.deepEqual(accounts, [{
    address: 'support@example.test', canCompose: false, canRead: false, canSend: false,
    id: CONNECTION_ID, label: 'Support', scope: 'shared', source: 'mailbox', status: 'disabled',
  }])
})

test('a Gmail 401 transitions the selected live connection to reauthorization', async () => {
  const updates: unknown[] = []
  const prisma = {
    commsConnection: {
      findMany: async () => [{
        disabledCapabilities: [], grantedScopes: [READ_SCOPE], id: CONNECTION_ID, status: 'active',
      }],
      findUnique: async () => ({
        credential: {
          accessTokenCiphertext: sealSecret('test-secret', 'access-token'),
          expiresAt: null,
          refreshTokenCiphertext: null,
        },
        disabledCapabilities: [], externalTenantId: 'tenant', externalUserId: 'person@example.test',
        grantedScopes: [READ_SCOPE], id: CONNECTION_ID, organizationId: ORGANIZATION_ID,
        ownerUserId: USER_ID, provider: 'google', status: 'active',
      }),
      updateMany: async (args: unknown) => { updates.push(args); return { count: 1 } },
    },
  } as unknown as PrismaClient
  await assert.rejects(
    () => listConnectedMailThreads(prisma, { organizationId: ORGANIZATION_ID, userId: USER_ID }, {
      accountId: CONNECTION_ID, pageSize: 25, source: 'gmail',
    }, {
      encryptionSecret: 'test-secret',
      fetchImpl: async () => ({
        json: async () => ({ error: { message: 'expired' } }), ok: false, status: 401,
        text: async () => '{"error":{"message":"expired"}}',
      }),
    }),
    (error: unknown) => error instanceof ConnectedMailError && error.code === 'NEEDS_REAUTHORIZATION',
  )
  assert.deepEqual(updates, [{
    data: { status: 'needs_reauthorization' },
    where: { id: CONNECTION_ID, status: { not: 'disconnected' } },
  }])
})

test('an SMTP failure is delivery_unknown and the same idempotency key never dials again', async () => {
  let action: Record<string, unknown> | undefined
  const sends: unknown[] = []
  const connection = {
    id: CONNECTION_ID, organizationId: ORGANIZATION_ID, ownerUserId: USER_ID, status: 'active',
    address: 'owner@example.test', imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'tls',
    smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'tls', username: 'owner@example.test',
  }
  const prisma = {
    mailboxConnection: { findFirst: async () => connection },
    mailboxConnectionCredential: {
      findUnique: async () => ({ secretCiphertext: sealSecret('test-secret', 'password') }),
    },
    mailboxSendAction: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        sends.push(create)
        action ??= { ...create, state: 'ready' }
        return action
      },
      updateMany: async ({ where, data }: { where: { state?: string }; data: Record<string, unknown> }) => {
        if (action?.state !== where.state) return { count: 0 }
        action = { ...action, ...data }
        return { count: 1 }
      },
      update: async () => action,
    },
  } as unknown as PrismaClient
  const input = {
    body: 'Hello', idempotencyKey: '44444444-4444-4444-8444-444444444444',
    subject: 'Status', to: ['recipient@example.test'],
  }
  const send = () => sendConnectedMailboxMail(
    prisma, { organizationId: ORGANIZATION_ID, userId: USER_ID }, CONNECTION_ID, input,
    { encryptionSecret: 'test-secret' },
  )
  await assert.rejects(send, (error: unknown) => error instanceof ConnectedMailError && error.code === 'DELIVERY_UNKNOWN')
  const firstMessageId = action?.messageId
  await assert.rejects(send, (error: unknown) => error instanceof ConnectedMailError && error.code === 'DELIVERY_UNKNOWN')
  assert.equal(action?.state, 'delivery_unknown')
  assert.match(String(firstMessageId), /^nessie-[0-9a-f-]+@example\.test$/)
  assert.equal(sends.length, 2, 'the replay sees the same durable action before refusing')
  assert.equal(action?.messageId, firstMessageId)
})

test('a known sent SMTP action replays before a revoked credential is loaded', async () => {
  let credentialReads = 0
  const connection = {
    id: CONNECTION_ID, organizationId: ORGANIZATION_ID, ownerUserId: USER_ID, status: 'active',
    address: 'owner@example.test', imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls',
    smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'tls', username: 'owner@example.test',
  }
  const prisma = {
    mailboxConnection: { findFirst: async () => connection },
    mailboxConnectionCredential: { findUnique: async () => { credentialReads += 1; return null } },
    mailboxSendAction: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => ({ ...create, state: 'sent' }),
      updateMany: async () => { throw new Error('a sent replay must not claim the action') },
    },
  } as unknown as PrismaClient
  const result = await sendConnectedMailboxMail(prisma, {
    organizationId: ORGANIZATION_ID, userId: USER_ID,
  }, CONNECTION_ID, {
    body: 'Hello', idempotencyKey: '44444444-4444-4444-8444-444444444444',
    subject: 'Status', to: ['recipient@example.test'],
  }, { encryptionSecret: 'test-secret' })
  assert.equal(result.status, 'sent')
  assert.equal(credentialReads, 0)
})

test('a live SMTP replay reports dispatching without a second dial or terminal transition', async () => {
  let credentialReads = 0
  const connection = {
    id: CONNECTION_ID, organizationId: ORGANIZATION_ID, ownerUserId: USER_ID, status: 'active',
    address: 'owner@example.test', imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls',
    smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'tls', username: 'owner@example.test',
  }
  const prisma = {
    mailboxConnection: { findFirst: async () => connection },
    mailboxConnectionCredential: { findUnique: async () => { credentialReads += 1; return null } },
    mailboxSendAction: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => ({ ...create, state: 'dispatching' }),
      updateMany: async () => { throw new Error('a live replay must not settle the action') },
    },
  } as unknown as PrismaClient
  const result = await sendConnectedMailboxMail(prisma, {
    organizationId: ORGANIZATION_ID, userId: USER_ID,
  }, CONNECTION_ID, {
    body: 'Hello', idempotencyKey: '44444444-4444-4444-8444-444444444444',
    subject: 'Status', to: ['recipient@example.test'],
  }, { encryptionSecret: 'test-secret', sendMailbox: async () => { throw new Error('must not dial') } })
  assert.equal(result.status, 'dispatching')
  assert.equal(credentialReads, 0)
})

test('an SMTP action cannot be replayed by a different owner', async () => {
  let credentialReads = 0
  const connection = {
    id: CONNECTION_ID, organizationId: ORGANIZATION_ID, ownerUserId: null, status: 'active',
    address: 'support@example.test', imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls',
    smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'tls', username: 'support@example.test',
  }
  const prisma = {
    mailboxConnection: { findFirst: async () => connection },
    mailboxConnectionCredential: { findUnique: async () => { credentialReads += 1; return null } },
    mailboxSendAction: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => ({
        ...create, ownerUserId: OTHER_USER_ID, state: 'sent',
      }),
      updateMany: async () => { throw new Error('a foreign action must not be claimed') },
    },
  } as unknown as PrismaClient
  await assert.rejects(
    () => sendConnectedMailboxMail(prisma, {
      organizationId: ORGANIZATION_ID, userId: USER_ID,
    }, CONNECTION_ID, {
      body: 'Hello', idempotencyKey: '44444444-4444-4444-8444-444444444444',
      subject: 'Status', to: ['recipient@example.test'],
    }, { encryptionSecret: 'test-secret' }),
    (error: unknown) => error instanceof ConnectedMailError && error.code === 'NOT_FOUND',
  )
  assert.equal(credentialReads, 0)
})

test('an invalid SMTP recipient is refused before credentials or a transport dial', async () => {
  let credentialReads = 0
  let sends = 0
  const connection = {
    id: CONNECTION_ID, organizationId: ORGANIZATION_ID, ownerUserId: USER_ID, status: 'active',
    address: 'owner@example.test', imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls',
    smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'tls', username: 'owner@example.test',
  }
  const prisma = {
    mailboxConnection: { findFirst: async () => connection },
    mailboxConnectionCredential: { findUnique: async () => { credentialReads += 1; return null } },
    mailboxSendAction: { upsert: async () => { throw new Error('an invalid recipient creates no action') } },
  } as unknown as PrismaClient
  await assert.rejects(() => sendConnectedMailboxMail(prisma, {
    organizationId: ORGANIZATION_ID, userId: USER_ID,
  }, CONNECTION_ID, {
    body: 'Hello', idempotencyKey: '44444444-4444-4444-8444-444444444444', subject: 'Status',
    to: ['Recipient <recipient@example.test>'],
  }, { encryptionSecret: 'test-secret', sendMailbox: async () => { sends += 1 } }),
  (error: unknown) => error instanceof ConnectedMailError && error.code === 'INVALID_RECIPIENT')
  assert.equal(credentialReads, 0)
  assert.equal(sends, 0)
})

test('a stale SMTP dispatch becomes terminal delivery_unknown', async () => {
  const updates: unknown[] = []
  const prisma = {
    mailboxSendAction: {
      findMany: async () => [{
        connectionId: CONNECTION_ID, id: '44444444-4444-4444-8444-444444444444',
        organizationId: ORGANIZATION_ID, ownerUserId: USER_ID,
      }],
      updateMany: async (input: unknown) => { updates.push(input); return { count: 1 } },
    },
  } as unknown as PrismaClient
  const settled = await resolveStaleMailboxSendDispatches(prisma, {
    now: () => new Date('2026-09-04T12:00:00.000Z'),
  })
  assert.equal(settled.length, 1)
  assert.match(JSON.stringify(updates[0]), /delivery_unknown/)
  assert.match(JSON.stringify(updates[0]), /11:58:00.000Z/)
})

test('SMTP action status requires both mailbox entitlement and action ownership', async () => {
  const connection = {
    id: CONNECTION_ID, organizationId: ORGANIZATION_ID, ownerUserId: USER_ID, status: 'active',
  }
  const prisma = {
    mailboxConnection: { findFirst: async () => connection },
    mailboxSendAction: { findFirst: async (input: { where: unknown }) => {
      assert.match(JSON.stringify(input.where), new RegExp(USER_ID))
      return { id: '44444444-4444-4444-8444-444444444444', state: 'delivery_unknown' }
    } },
  } as unknown as PrismaClient
  const action = await readMailboxSendAction(prisma, {
    organizationId: ORGANIZATION_ID, userId: USER_ID,
  }, CONNECTION_ID, '44444444-4444-4444-8444-444444444444')
  assert.deepEqual(action, { id: '44444444-4444-4444-8444-444444444444', state: 'delivery_unknown' })
})
