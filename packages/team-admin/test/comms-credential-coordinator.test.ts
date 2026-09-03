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
        disabledCapabilities: [],
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
    requiredScopes: [REQUIRED_SCOPE],
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
      requiredScopes: [REQUIRED_SCOPE],
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

// ── Selection: every refusal below used to be a silent best guess ───────────

const CONTACTS = 'https://www.googleapis.com/auth/contacts.readonly'
const DIRECTORY = 'https://www.googleapis.com/auth/directory.readonly'

type FakeRow = {
  id: string
  status: string
  grantedScopes: string[]
  disabledCapabilities: string[]
}

const prismaWithRows = (rows: FakeRow[]): PrismaClient => ({
  commsConnection: {
    findMany: async (input?: { where?: { id?: string } }) => {
      const id = input?.where?.id
      return id ? rows.filter((row) => row.id === id) : rows
    },
    findUnique: async () => null,
  },
} as unknown as PrismaClient)

const load = (rows: FakeRow[], overrides: Record<string, unknown> = {}) =>
  loadUserGoogleCommsCredential(prismaWithRows(rows), {
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    requiredScopes: [REQUIRED_SCOPE],
    encryptionSecret: ENCRYPTION_SECRET,
    ...overrides,
  })

const rejectsWith = async (
  promise: Promise<unknown>,
  code: string,
): Promise<void> => {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof CommsCredentialCoordinatorError
      && error.code === code,
  )
}

const row = (overrides: Partial<FakeRow> = {}): FakeRow => ({
  id: CONNECTION_ID,
  status: 'active',
  grantedScopes: [REQUIRED_SCOPE],
  disabledCapabilities: [],
  ...overrides,
})

test('a multi-scope capability needs ALL its scopes, not any one', async () => {
  await rejectsWith(
    load([row({ grantedScopes: [CONTACTS] })], {
      requiredScopes: [CONTACTS, DIRECTORY],
    }),
    'SCOPE_MISSING',
  )
})

test('a locally blocked capability is refused distinctly from a missing scope', async () => {
  // Google cannot partially revoke, so the scope is still live at Google and
  // only this check stops the call. The remedy differs from SCOPE_MISSING:
  // unblock here, rather than re-consent at Google.
  await rejectsWith(
    load([row({ disabledCapabilities: ['meet.create'] })], {
      capabilityId: 'meet.create',
    }),
    'CAPABILITY_BLOCKED',
  )
})

test('a block on a different capability does not refuse this one', async () => {
  await rejectsWith(
    load([row({ disabledCapabilities: ['gmail.read'] })], {
      capabilityId: 'meet.create',
      // No credential on the fake row, so success surfaces as the next step's
      // refusal rather than CAPABILITY_BLOCKED.
    }),
    'CONNECTION_NOT_FOUND',
  )
})

test('two qualifying accounts refuse rather than silently picking one', async () => {
  await rejectsWith(
    load([
      row({ id: CONNECTION_ID }),
      row({ id: '00000000-0000-4000-8000-00000000000a' }),
    ]),
    'AMBIGUOUS_ACCOUNT',
  )
})

test('an explicit connectionId resolves the ambiguity', async () => {
  // Selecting one account leaves a single candidate; it then fails later in
  // the pipeline (no credential row on the fake), never on AMBIGUOUS_ACCOUNT.
  await rejectsWith(
    load(
      [
        row({ id: CONNECTION_ID }),
        row({ id: '00000000-0000-4000-8000-00000000000a' }),
      ],
      { connectionId: CONNECTION_ID },
    ),
    'CONNECTION_NOT_FOUND',
  )
})

test('needs_reauthorization is reported ahead of a generic scope failure', async () => {
  await rejectsWith(
    load([row({ status: 'needs_reauthorization' })]),
    'NEEDS_REAUTHORIZATION',
  )
})

test('no connection at all is CONNECTION_NOT_FOUND', async () => {
  await rejectsWith(load([]), 'CONNECTION_NOT_FOUND')
})
