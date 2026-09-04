import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { sealSecret } from '@nessie/comms-connect'

import { composeDraftForUser, GmailDraftError, fingerprintDraft } from '../src/gmail-drafts.js'

const ORG = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'
const CONN = '00000000-0000-4000-8000-000000000003'
const ACTION = '00000000-0000-4000-8000-000000000004'
const SCOPE = 'https://www.googleapis.com/auth/gmail.compose'
const ENCRYPTION_SECRET = 'gmail-draft-test-secret'

type Row = {
  id: string
  organizationId: string
  ownerUserId: string
  connectionId: string
  providerDraftId: string | null
  providerThreadId: string | null
  contentFingerprint: string
  revision: number
  state: string
  sendAfter: Date | null
  claimedAt: Date | null
}

const composeInput = (body = 'Here it is.') => ({
  idempotencyKey: '00000000-0000-4000-8000-000000000099',
  organizationId: ORG,
  userId: USER,
  message: { body, subject: 'Quarterly update', to: ['jana@example.com'] },
})

const existingRow = (): Row => ({
  id: ACTION,
  organizationId: ORG,
  ownerUserId: USER,
  connectionId: CONN,
  providerDraftId: 'provider-draft-1',
  providerThreadId: null,
  contentFingerprint: fingerprintDraft({
    attachmentIds: [], body: 'Here it is.', subject: 'Quarterly update', to: ['jana@example.com'],
  }),
  revision: 1,
  state: 'draft',
  sendAfter: null,
  claimedAt: null,
})

const makePrisma = (options: { failPersistProviderDraft?: boolean; existing?: Row } = {}) => {
  const state: { creates: number; row: Row | null } = { creates: 0, row: options.existing ?? null }
  const prisma = {
    gmailDraftAction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.creates += 1
        state.row = {
          ...existingRow(), providerDraftId: null, state: 'creating',
          contentFingerprint: String(data.contentFingerprint), claimedAt: new Date(),
        }
        return state.row
      },
      findUnique: async () => state.row,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.failPersistProviderDraft) throw new Error('database interrupted after provider response')
        state.row = { ...state.row!, ...data } as Row
        return state.row
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        state.row = { ...state.row!, ...data } as Row
        return { count: 1 }
      },
    },
    commsConnection: {
      findMany: async () => [{ id: CONN, status: 'active', grantedScopes: [SCOPE], disabledCapabilities: [] }],
      findUnique: async () => ({
        id: CONN, organizationId: ORG, ownerUserId: USER, provider: 'google',
        externalTenantId: 'me@example.com', externalUserId: 'me@example.com',
        grantedScopes: [SCOPE], credential: {
          accessTokenCiphertext: sealSecret(ENCRYPTION_SECRET, 'access-token'),
          refreshTokenCiphertext: null, expiresAt: new Date('2999-01-01T00:00:00.000Z'),
        },
      }),
    },
  } as unknown as PrismaClient
  return { prisma, state }
}

const deps = (handler: (url: string) => { status: number; body: unknown }) => ({
  encryptionSecret: ENCRYPTION_SECRET,
  fetchImpl: (async (url: string) => {
    const { status, body } = handler(url)
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => body, text: async () => JSON.stringify(body),
    }
  }) as never,
})

test('an edited create replay refuses the old idempotent provider draft', async () => {
  const { prisma } = makePrisma({ existing: existingRow() })
  let providerCalls = 0
  await assert.rejects(
    composeDraftForUser(prisma, composeInput('This is the edited version.'), deps(() => {
      providerCalls += 1
      return { status: 200, body: {} }
    })),
    (error: unknown) => error instanceof GmailDraftError && error.code === 'DRAFT_CHANGED',
  )
  assert.equal(providerCalls, 0)
})

test('a post-provider crash replay never creates a second Gmail draft', async () => {
  const { prisma, state } = makePrisma({ failPersistProviderDraft: true })
  let providerCalls = 0
  const provider = (url: string) => {
    if (!url.endsWith('/drafts')) throw new Error(`unexpected provider request ${url}`)
    providerCalls += 1
    return { status: 200, body: { id: 'provider-draft-1', message: { id: 'provider-message-1' } } }
  }
  await assert.rejects(composeDraftForUser(prisma, composeInput(), deps(provider)), GmailDraftError)
  await assert.rejects(composeDraftForUser(prisma, composeInput(), deps(provider)), GmailDraftError)
  assert.equal(state.creates, 1)
  assert.equal(providerCalls, 1)
})
