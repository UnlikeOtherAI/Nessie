import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { sealSecret } from '@nessie/comms-connect'

import {
  GmailDraftError,
  discardDraftForUser,
  dispatchClaimedDraft,
  fingerprintDraft,
  sendDraftForUser,
  undoHeldSend,
} from '../src/gmail-drafts.js'

const ORG = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'
const CONN = '00000000-0000-4000-8000-000000000003'
const ACTION = '00000000-0000-4000-8000-000000000004'
const SCOPE = 'https://www.googleapis.com/auth/gmail.compose'
const ENCRYPTION_SECRET = 'gmail-draft-test-secret'

/** The draft as Gmail would return it. */
const liveDraft = (overrides: Record<string, unknown> = {}) => ({
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

type Row = {
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
  to: ['jana@example.com'],
  subject: 'Quarterly update',
  body: 'Here it is.',
  attachmentIds: [],
})

const makePrisma = (row: Row) => {
  const state = { row }
  const prisma = {
    gmailDraftAction: {
      findFirst: async () => state.row,
      findUnique: async () => state.row,
      findUniqueOrThrow: async () => state.row,
      updateMany: async (input: {
        where: {
          state?: string
          OR?: Array<{
            state: string
            claimedAt?: { lt: Date }
          }>
        }
        data: Record<string, unknown>
      }) => {
        const matches = input.where.OR
          ? input.where.OR.some((condition) => {
              if (condition.state !== state.row.state) return false
              if (!condition.claimedAt) return true
              return state.row.claimedAt !== null
                && state.row.claimedAt < condition.claimedAt.lt
            })
          : !input.where.state || input.where.state === state.row.state
        if (!matches) return { count: 0 }
        state.row = { ...state.row, ...input.data } as Row
        return { count: 1 }
      },
      update: async (input: { data: Record<string, unknown> }) => {
        state.row = { ...state.row, ...input.data } as Row
        return state.row
      },
    },
    commsConnection: {
      findMany: async () => [{
        id: CONN,
        status: 'active',
        grantedScopes: [SCOPE],
        disabledCapabilities: [],
      }],
      findUnique: async () => ({
        id: CONN,
        organizationId: ORG,
        ownerUserId: USER,
        provider: 'google',
        externalTenantId: 'me@example.com',
        externalUserId: 'me@example.com',
        grantedScopes: [SCOPE],
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

const row = (overrides: Partial<Row> = {}): Row => ({
  id: ACTION,
  organizationId: ORG,
  ownerUserId: USER,
  connectionId: CONN,
  providerDraftId: 'draft-1',
  providerThreadId: null,
  contentFingerprint: baseFingerprint,
  revision: 1,
  state: 'draft',
  sendAfter: null,
  claimedAt: null,
  ...overrides,
})

/** These tests are about ordering and the fingerprint guard, so the credential
 * is a genuinely sealed token and the fetch layer ignores the bearer. */
const deps = (
  handler: (url: string, method: string) => { status: number; body: unknown },
) => ({
  encryptionSecret: ENCRYPTION_SECRET,
  fetchImpl: (async (url: string, init?: { method?: string }) => {
    const { status, body } = handler(url, init?.method ?? 'GET')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }) as never,
  now: () => new Date('2026-09-02T10:00:00.000Z'),
})

const routes = (draft: unknown, onSend?: () => void) =>
  (url: string, method: string) => {
    if (url.includes('/drafts/send')) {
      onSend?.()
      return { status: 200, body: { id: 'sent-1', threadId: 'thread-1' } }
    }
    if (url.includes('/drafts/')) return { status: 200, body: draft }
    throw new Error(`unexpected ${method} ${url}`)
  }

// The load-bearing guard: an approval or a rendered card binds to CONTENT, and
// the draft is mutable through Gmail, the card's Edit button, and other runs.
test('refuses to send when the live draft no longer matches what was approved', async () => {
  const { prisma } = makePrisma(row())
  let sendCalls = 0
  const tampered = liveDraft({
    message: {
      id: 'msg-2',
      threadId: 'thread-1',
      payload: {
        headers: [
          { name: 'To', value: 'attacker@evil.test' },
          { name: 'Subject', value: 'Quarterly update' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('Here it is.', 'utf8').toString('base64url') },
      },
    },
  })
  await assert.rejects(
    sendDraftForUser(
      prisma,
      { organizationId: ORG, userId: USER, draftActionId: ACTION },
      deps(routes(tampered, () => { sendCalls += 1 })),
    ),
    (error: unknown) =>
      error instanceof GmailDraftError && error.code === 'DRAFT_CHANGED',
  )
  assert.equal(sendCalls, 0, 'no message may leave when the content changed')
})

test('a refused send leaves the draft sendable, not stuck in sending', async () => {
  const { prisma, state } = makePrisma(row())
  await assert.rejects(
    sendDraftForUser(
      prisma,
      {
        organizationId: ORG,
        userId: USER,
        draftActionId: ACTION,
        expectedFingerprint: 'a-stale-fingerprint',
      },
      deps(routes(liveDraft())),
    ),
    GmailDraftError,
  )
  assert.equal(state.row.state, 'draft')
})

test('sends when the fingerprint matches', async () => {
  const { prisma, state } = makePrisma(row())
  let sendCalls = 0
  const result = await sendDraftForUser(
    prisma,
    { organizationId: ORG, userId: USER, draftActionId: ACTION },
    deps(routes(liveDraft(), () => { sendCalls += 1 })),
  )
  assert.equal(result.status, 'sent')
  assert.equal(sendCalls, 1)
  assert.equal(state.row.state, 'sent')
})

test('a second send finds the draft already claimed', async () => {
  const { prisma } = makePrisma(row({ state: 'sending' }))
  await assert.rejects(
    sendDraftForUser(
      prisma,
      { organizationId: ORG, userId: USER, draftActionId: ACTION },
      deps(routes(liveDraft())),
    ),
    (error: unknown) =>
      error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
})

test('an already-sent draft cannot be sent again', async () => {
  const { prisma } = makePrisma(row({ state: 'sent' }))
  await assert.rejects(
    sendDraftForUser(
      prisma,
      { organizationId: ORG, userId: USER, draftActionId: ACTION },
      deps(routes(liveDraft())),
    ),
    (error: unknown) =>
      error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
})

test('a held send does not reach the provider until the window elapses', async () => {
  const { prisma, state } = makePrisma(row())
  let sendCalls = 0
  const result = await sendDraftForUser(
    prisma,
    {
      organizationId: ORG,
      userId: USER,
      draftActionId: ACTION,
      holdMs: 15_000,
    },
    deps(routes(liveDraft(), () => { sendCalls += 1 })),
  )
  assert.equal(result.status, 'held')
  assert.equal(sendCalls, 0)
  assert.equal(state.row.state, 'sending')
  assert.deepEqual(state.row.sendAfter, new Date('2026-09-02T10:00:15.000Z'))
})

test('undo returns a held send to draft', async () => {
  const { prisma, state } = makePrisma(
    row({ state: 'sending', sendAfter: new Date('2026-09-02T10:00:15.000Z') }),
  )
  const record = await undoHeldSend(prisma, {
    organizationId: ORG,
    userId: USER,
    draftActionId: ACTION,
  })
  assert.equal(record.state, 'draft')
  assert.equal(state.row.sendAfter, null)
})

test('undo after the send already went out is refused', async () => {
  const { prisma } = makePrisma(row({ state: 'sent' }))
  await assert.rejects(
    undoHeldSend(prisma, {
      organizationId: ORG,
      userId: USER,
      draftActionId: ACTION,
    }),
    (error: unknown) =>
      error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
})

test('discard refuses a held or actively dispatching draft', async () => {
  for (const state of ['sending', 'dispatching']) {
    const seeded = makePrisma(row({ state }))
    await assert.rejects(
      discardDraftForUser(seeded.prisma, {
        organizationId: ORG, userId: USER, draftActionId: ACTION,
      }, deps(routes(liveDraft()))),
      (error: unknown) => error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
    )
    assert.equal(seeded.state.row.state, state)
  }
})

test('discard claims the durable draft before deleting it at Gmail', async () => {
  const seeded = makePrisma(row())
  let providerState: string | null = null
  const result = await discardDraftForUser(seeded.prisma, {
    organizationId: ORG, userId: USER, draftActionId: ACTION,
  }, deps((_url, method) => {
    assert.equal(method, 'DELETE')
    providerState = seeded.state.row.state
    return { status: 200, body: {} }
  }))
  assert.equal(providerState, 'discarded')
  assert.equal(result.state, 'discarded')
})

test('a draft belonging to somebody else is not found', async () => {
  const prisma = {
    gmailDraftAction: { findFirst: async () => null },
  } as unknown as PrismaClient
  await assert.rejects(
    sendDraftForUser(
      prisma,
      { organizationId: ORG, userId: 'someone-else', draftActionId: ACTION },
      deps(routes(liveDraft())),
    ),
    (error: unknown) =>
      error instanceof GmailDraftError && error.code === 'DRAFT_NOT_FOUND',
  )
})


// ── The cross-worker claim ────────────────────────────────────────────────
// These tests simulate two worker replicas racing one row through the same
// fake, which honours the conditional update's where clause exactly.

const claimedRow = (overrides: Partial<Row> = {}) =>
  row({
    state: 'sending',
    sendAfter: new Date('2026-09-02T09:59:59.000Z'),
    ...overrides,
  })

test('two concurrent dispatches on one row produce exactly ONE Gmail send', async () => {
  const { prisma, state } = makePrisma(claimedRow())
  let sendCalls = 0
  // Hold the provider call open so the second dispatcher attempts its claim
  // while the first is genuinely mid-send — the exact double-send window.
  let releaseSend!: () => void
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
  const fake = deps(routes(liveDraft(), () => { sendCalls += 1 }))
  const gatedDeps = {
    ...fake,
    fetchImpl: (async (url: string, init?: { method?: string }) => {
      if (url.includes('/drafts/send')) await sendGate
      return fake.fetchImpl(url, init)
    }) as never,
  }

  const first = dispatchClaimedDraft(prisma, ACTION, gatedDeps)
  // The claim update resolves before the provider call starts.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.row.state, 'dispatching')
  const second = dispatchClaimedDraft(prisma, ACTION, gatedDeps)
  releaseSend()

  const firstResult = await first
  await assert.rejects(
    second,
    (error: unknown) =>
      error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
  assert.equal(firstResult.status, 'sent')
  assert.equal(sendCalls, 1, 'the losing replica must never reach Gmail')
  assert.equal(state.row.state, 'sent')
})

test('the loser no-ops and leaves the row in the winner\'s state', async () => {
  const { prisma, state } = makePrisma(claimedRow())
  let sendCalls = 0
  const winner = dispatchClaimedDraft(
    prisma,
    ACTION,
    deps(routes(liveDraft(), () => { sendCalls += 1 })),
  )
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    dispatchClaimedDraft(prisma, ACTION, deps(routes(liveDraft()))),
    (error: unknown) =>
      error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
  await winner
  assert.equal(state.row.state, 'sent')
  assert.equal(sendCalls, 1)
})

test('an ambiguous Gmail send failure becomes non-retryable delivery_unknown', async () => {
  const { prisma, state } = makePrisma(claimedRow())
  await assert.rejects(
    dispatchClaimedDraft(
      prisma,
      ACTION,
      deps((url) => {
        if (url.includes('/drafts/send')) {
          return { status: 500, body: { error: { message: 'gmail down' } } }
        }
        return { status: 200, body: liveDraft() }
      }),
    ),
    (error: unknown) =>
      error instanceof GmailDraftError && error.code === 'DELIVERY_UNKNOWN',
  )
  assert.equal(state.row.state, 'delivery_unknown')
  assert.equal(state.row.claimedAt, null)
  await assert.rejects(
    sendDraftForUser(prisma, { organizationId: ORG, userId: USER, draftActionId: ACTION }, deps(routes(liveDraft()))),
    (error: unknown) => error instanceof GmailDraftError && error.code === 'DELIVERY_UNKNOWN',
  )
})

test('a fresh dispatching row cannot be stolen mid-send', async () => {
  const { prisma } = makePrisma(
    claimedRow({
      state: 'dispatching',
      claimedAt: new Date('2026-09-02T09:59:58.000Z'),
    }),
  )
  let sendCalls = 0
  await assert.rejects(
    dispatchClaimedDraft(
      prisma,
      ACTION,
      deps(routes(liveDraft(), () => { sendCalls += 1 })),
    ),
    (error: unknown) =>
      error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
  assert.equal(sendCalls, 0)
})

test('a stale dispatch is never reclaimed for another Gmail send', async () => {
  const { prisma, state } = makePrisma(
    claimedRow({ state: 'dispatching', claimedAt: new Date('2026-09-02T09:00:00.000Z') }),
  )
  let sendCalls = 0
  await assert.rejects(
    dispatchClaimedDraft(prisma, ACTION, deps(routes(liveDraft(), () => { sendCalls += 1 }))),
    (error: unknown) => error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
  assert.equal(sendCalls, 0)
  assert.equal(state.row.state, 'dispatching')
})
