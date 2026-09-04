import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { sealSecret } from '@nessie/comms-connect'

import {
  ConnectedMailError,
  listConnectedMailAccounts,
  listConnectedMailThreads,
} from '../src/connected-mail.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333'
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
