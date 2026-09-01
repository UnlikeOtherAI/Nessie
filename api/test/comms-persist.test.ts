import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { persistConnectedAccount } from '../src/routes/comms/persist.js'

test('reconnect preserves a stored refresh token when Google omits one', async () => {
  let credentialUpdate: Record<string, unknown> | undefined
  const transaction = {
    commsConnection: {
      upsert: async () => ({ id: 'connection-1' }),
    },
    commsConnectionCredential: {
      upsert: async (input: { update: Record<string, unknown> }) => {
        credentialUpdate = input.update
      },
    },
    commsSyncJob: {
      findFirst: async () => ({ id: 'existing-job' }),
      create: async () => undefined,
    },
  }
  const prisma = {
    $transaction: async (
      callback: (tx: typeof transaction) => Promise<string>,
    ) => callback(transaction),
  } as unknown as PrismaClient

  await persistConnectedAccount(prisma, {
    encryptionSecret: 'encryption-secret',
    organizationId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    provider: 'google',
    connect: {
      externalTenantId: 'person@example.com',
      externalUserId: 'person@example.com',
      grantedScopes: ['scope-a'],
      credential: {
        accessToken: 'new-access-token',
        scopes: ['scope-a'],
      },
    },
  })

  assert.ok(credentialUpdate)
  assert.equal('refreshTokenCiphertext' in credentialUpdate, false)
})
