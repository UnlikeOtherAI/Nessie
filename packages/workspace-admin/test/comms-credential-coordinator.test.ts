import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  openSecret,
  sealSecret,
  type CommunicationsConnector,
} from '@nessie/comms-connect'

import {
  CommsCredentialCoordinatorError,
  loadUserGoogleCommsCredential,
} from '../src/index.js'

const ENCRYPTION_SECRET = 'credential-test-secret'
const CONNECTION_ID = '00000000-0000-4000-8000-000000000001'
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000002'
const USER_ID = '00000000-0000-4000-8000-000000000003'
const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/meetings.space.created'

const connection = () => ({
  id: CONNECTION_ID,
  organizationId: ORGANIZATION_ID,
  ownerUserId: USER_ID,
  provider: 'google' as const,
  externalTenantId: 'person@example.com',
  externalUserId: 'person@example.com',
  status: 'active' as const,
  grantedScopes: [REQUIRED_SCOPE],
  initialSyncCompletedAt: null,
  lastSuccessfulSyncAt: null,
  createdAt: new Date('2026-08-30T09:00:00.000Z'),
  updatedAt: new Date('2026-08-30T10:00:00.000Z'),
  credential: {
    id: '00000000-0000-4000-8000-000000000004',
    connectionId: CONNECTION_ID,
    accessTokenCiphertext: sealSecret(ENCRYPTION_SECRET, 'old-access'),
    refreshTokenCiphertext: sealSecret(ENCRYPTION_SECRET, 'stored-refresh'),
    expiresAt: new Date('2026-08-30T10:59:00.000Z'),
    keyVersion: 1,
    scopeHash: 'old-scope-hash',
    createdAt: new Date('2026-08-30T09:00:00.000Z'),
    updatedAt: new Date('2026-08-30T10:00:00.000Z'),
  },
})

const connectorWithRefresh = (
  refreshCredentials: CommunicationsConnector['refreshCredentials'],
): CommunicationsConnector => ({ refreshCredentials } as CommunicationsConnector)

const createPrisma = () => {
  let credentialUpdate: Record<string, unknown> | undefined
  let connectionStatus: string | undefined
  const row = connection()
  const transaction = {
    $queryRaw: async () => [{ id: row.credential.id }],
    commsConnection: {
      findUnique: async () => row,
      update: async (input: { data: Record<string, unknown> }) => {
        if (typeof input.data['status'] === 'string') {
          connectionStatus = input.data['status']
        }
        return row
      },
    },
    commsConnectionCredential: {
      update: async (input: { data: Record<string, unknown> }) => {
        credentialUpdate = input.data
        return row.credential
      },
    },
  }
  const prisma = {
    commsConnection: {
      findMany: async () => [{
        id: row.id,
        status: row.status,
        grantedScopes: row.grantedScopes,
      }],
      findUnique: async () => row,
    },
    $transaction: async (
      callback: (tx: typeof transaction) => Promise<unknown>,
    ) => callback(transaction),
  } as unknown as PrismaClient
  return {
    connectionStatus: () => connectionStatus,
    credentialUpdate: () => credentialUpdate,
    prisma,
  }
}

test('expired refresh preserves the stored refresh token when omitted', async () => {
  const fake = createPrisma()
  const context = await loadUserGoogleCommsCredential(fake.prisma, {
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    requiredScope: REQUIRED_SCOPE,
    encryptionSecret: ENCRYPTION_SECRET,
    now: new Date('2026-08-30T11:00:00.000Z'),
    connector: connectorWithRefresh(async () => ({
      accessToken: 'new-access',
      expiresAt: '2026-08-30T12:00:00.000Z',
      scopes: [REQUIRED_SCOPE],
    })),
  })

  assert.equal(context.credential.refreshToken, 'stored-refresh')
  const ciphertext = fake.credentialUpdate()?.['refreshTokenCiphertext']
  assert.equal(typeof ciphertext, 'string')
  assert.equal(
    openSecret(ENCRYPTION_SECRET, ciphertext as string),
    'stored-refresh',
  )
})

test('a rejected refresh atomically marks reauthorization before refusing', async () => {
  const fake = createPrisma()
  await assert.rejects(
    loadUserGoogleCommsCredential(fake.prisma, {
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      requiredScope: REQUIRED_SCOPE,
      encryptionSecret: ENCRYPTION_SECRET,
      now: new Date('2026-08-30T11:00:00.000Z'),
      connector: connectorWithRefresh(async () => {
        throw { needsReauthorization: true }
      }),
    }),
    (error: unknown) => error instanceof CommsCredentialCoordinatorError
      && error.code === 'NEEDS_REAUTHORIZATION',
  )
  assert.equal(fake.connectionStatus(), 'needs_reauthorization')
})
