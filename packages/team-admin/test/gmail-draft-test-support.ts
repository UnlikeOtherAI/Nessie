import type { PrismaClient } from '@prisma/client'
import { sealSecret } from '@nessie/comms-connect'

import { fingerprintDraft } from '../src/gmail-drafts.js'

export const ORG = '00000000-0000-4000-8000-000000000001'
export const USER = '00000000-0000-4000-8000-000000000002'
export const CONN = '00000000-0000-4000-8000-000000000003'
export const ACTION = '00000000-0000-4000-8000-000000000004'
export const ENCRYPTION_SECRET = 'gmail-draft-test-secret'
const SCOPE = 'https://www.googleapis.com/auth/gmail.compose'

export const liveDraft = (overrides: Record<string, unknown> = {}) => ({
  id: 'draft-1',
  message: {
    id: 'msg-1',
    threadId: 'thread-1',
    payload: {
      headers: [
        { name: 'To', value: 'jana@example.com' },
        { name: 'Subject', value: 'Quarterly update' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from('Here it is.', 'utf8').toString('base64url') },
    },
  },
  ...overrides,
})

export type DraftRow = {
  id: string
  organizationId: string
  ownerUserId: string
  connectionId: string
  providerDraftId: string
  providerThreadId: string | null
  contentFingerprint: string
  revision: number
  state: string
  sendAfter: Date | null
  claimedAt: Date | null
}

const baseFingerprint = fingerprintDraft({
  to: ['jana@example.com'], subject: 'Quarterly update', body: 'Here it is.', threadId: 'thread-1', attachmentIds: [],
})

export const row = (overrides: Partial<DraftRow> = {}): DraftRow => ({
  id: ACTION,
  organizationId: ORG,
  ownerUserId: USER,
  connectionId: CONN,
  providerDraftId: 'draft-1',
  providerThreadId: 'thread-1',
  contentFingerprint: baseFingerprint,
  revision: 1,
  state: 'draft',
  sendAfter: null,
  claimedAt: null,
  ...overrides,
})

export const claimedRow = (overrides: Partial<DraftRow> = {}) => row({
  state: 'sending', sendAfter: new Date('2026-09-02T09:59:59.000Z'), ...overrides,
})

export const makePrisma = (seed: DraftRow) => {
  const state = { row: seed }
  const prisma = {
    gmailDraftAction: {
      findFirst: async () => state.row,
      findUnique: async () => state.row,
      findUniqueOrThrow: async () => state.row,
      updateMany: async (input: {
        where: { state?: string; OR?: Array<{ state: string; claimedAt?: { lt: Date } }> }
        data: Record<string, unknown>
      }) => {
        const matches = input.where.OR
          ? input.where.OR.some((condition) => condition.state === state.row.state
            && (!condition.claimedAt || (state.row.claimedAt !== null && state.row.claimedAt < condition.claimedAt.lt)))
          : !input.where.state || input.where.state === state.row.state
        if (!matches) return { count: 0 }
        state.row = { ...state.row, ...input.data } as DraftRow
        return { count: 1 }
      },
      update: async (input: { data: Record<string, unknown> }) => {
        state.row = { ...state.row, ...input.data } as DraftRow
        return state.row
      },
    },
    commsConnection: {
      findMany: async () => [{ id: CONN, status: 'active', grantedScopes: [SCOPE], disabledCapabilities: [] }],
      findUnique: async () => ({
        id: CONN, organizationId: ORG, ownerUserId: USER, provider: 'google',
        externalTenantId: 'me@example.com', externalUserId: 'me@example.com', grantedScopes: [SCOPE],
        credential: {
          accessTokenCiphertext: sealSecret(ENCRYPTION_SECRET, 'access-token'),
          refreshTokenCiphertext: null,
          expiresAt: new Date('2999-01-01T00:00:00.000Z'),
        },
      }),
    },
  } as unknown as PrismaClient
  return { prisma, state }
}

export const deps = (handler: (url: string, method: string) => { status: number; body: unknown }) => ({
  encryptionSecret: ENCRYPTION_SECRET,
  fetchImpl: (async (url: string, init?: { method?: string }) => {
    const { status, body } = handler(url, init?.method ?? 'GET')
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
  }) as never,
  now: () => new Date('2026-09-02T10:00:00.000Z'),
})

export const routes = (draft: unknown, onSend?: () => void) => (url: string, method: string) => {
  if (url.includes('/drafts/send') || url.includes('/messages/send')) {
    onSend?.()
    return { status: 200, body: { id: 'sent-1', threadId: 'thread-1' } }
  }
  if (url.includes('/drafts/')) return { status: 200, body: draft }
  throw new Error(`unexpected ${method} ${url}`)
}
