import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GmailDraftError,
  discardDraftForUser,
  dispatchClaimedDraft,
  fingerprintDraft,
  sendDraftForUser,
  undoHeldSend,
  updateDraftForUser,
} from '../src/gmail-drafts.js'

import {
  ACTION,
  ENCRYPTION_SECRET,
  ORG,
  USER,
  claimedRow,
  deps,
  liveDraft,
  makePrisma,
  row,
  routes,
} from './gmail-draft-test-support.js'

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
      if (url.includes('/messages/send')) await sendGate
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

test('dispatch sends the captured draft bytes when Gmail mutates after validation', async () => {
  const { prisma } = makePrisma(claimedRow())
  const verified = liveDraft()
  let providerDraft = verified
  let sentRaw = ''
  await dispatchClaimedDraft(prisma, ACTION, {
    encryptionSecret: ENCRYPTION_SECRET,
    fetchImpl: (async (url: string, init?: { body?: string; method?: string }) => {
      if (url.includes('/drafts/') && (init?.method ?? 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => providerDraft,
          text: async () => JSON.stringify(providerDraft),
        }
      }
      if (url.includes('/messages/send')) {
        providerDraft = liveDraft({
          message: {
            id: 'mutated', threadId: 'thread-1',
            payload: {
              headers: [{ name: 'To', value: 'attacker@evil.test' }, { name: 'Subject', value: 'Changed' }],
              mimeType: 'text/plain', body: { data: Buffer.from('Changed', 'utf8').toString('base64url') },
            },
          },
        })
        sentRaw = String(JSON.parse(init.body ?? '{}').raw ?? '')
        return { ok: true, status: 200, json: async () => ({ id: 'sent-1' }), text: async () => '{"id":"sent-1"}' }
      }
      if (init?.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    }) as never,
    now: () => new Date('2026-09-02T10:00:00.000Z'),
  })
  const sent = Buffer.from(sentRaw, 'base64url').toString('utf8')
  assert.match(sent, /To: jana@example\.com/)
  assert.match(sent, /Subject: Quarterly update/)
  assert.match(sent, /SGVyZSBpdCBpcy4=/)
  assert.doesNotMatch(sent, /attacker@evil\.test|Changed/)
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

test('an update cannot overwrite a send claim after Gmail content was checked', async () => {
  const { prisma, state } = makePrisma(row())
  let releaseUpdate!: () => void
  const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve })
  const gatedDeps = {
    ...deps(routes(liveDraft())),
    fetchImpl: (async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT' && url.includes('/drafts/')) await updateGate
      return deps(routes(liveDraft())).fetchImpl(url, init)
    }) as never,
  }
  const updating = updateDraftForUser(prisma, {
    organizationId: ORG,
    userId: USER,
    draftActionId: ACTION,
    message: { to: ['jana@example.com'], subject: 'Edited', body: 'Updated text.' },
  }, gatedDeps)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.row.state, 'updating')
  await assert.rejects(
    sendDraftForUser(prisma, { organizationId: ORG, userId: USER, draftActionId: ACTION }, gatedDeps),
    (error: unknown) => error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
  releaseUpdate()
  await updating
  assert.equal(state.row.state, 'draft')
  assert.equal(state.row.contentFingerprint, fingerprintDraft({
    to: ['jana@example.com'], subject: 'Edited', body: 'Updated text.', attachmentIds: [],
  }))
})

test('a send claim rejects a concurrent update before it can resurrect the action', async () => {
  const { prisma, state } = makePrisma(row())
  let releaseRead!: () => void
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
  let updateCalls = 0
  const gatedDeps = {
    ...deps(routes(liveDraft())),
    fetchImpl: (async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/drafts/')) await readGate
      if (init?.method === 'PUT') updateCalls += 1
      return deps(routes(liveDraft())).fetchImpl(url, init)
    }) as never,
  }
  const sending = sendDraftForUser(prisma, { organizationId: ORG, userId: USER, draftActionId: ACTION }, gatedDeps)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.row.state, 'sending')
  await assert.rejects(
    updateDraftForUser(prisma, {
      organizationId: ORG,
      userId: USER,
      draftActionId: ACTION,
      message: { to: ['jana@example.com'], subject: 'Edited', body: 'Updated text.' },
    }, gatedDeps),
    (error: unknown) => error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
  assert.equal(updateCalls, 0)
  releaseRead()
  await sending
  assert.equal(state.row.state, 'sent')
})

test('an ambiguous Gmail send failure becomes non-retryable delivery_unknown', async () => {
  const { prisma, state } = makePrisma(claimedRow())
  await assert.rejects(
    dispatchClaimedDraft(
      prisma,
      ACTION,
      deps((url) => {
        if (url.includes('/messages/send')) {
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
