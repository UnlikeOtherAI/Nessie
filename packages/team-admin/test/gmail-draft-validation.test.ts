import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GmailDraftError, fingerprintDraft, sendDraftForUser, updateDraftForUser,
} from '../src/gmail-drafts.js'
import { ACTION, ENCRYPTION_SECRET, ORG, USER, deps, liveDraft, makePrisma, row, routes } from './gmail-draft-test-support.js'

test('a held send starts its undo window after provider validation', async () => {
  const { prisma } = makePrisma(row())
  let now = new Date('2026-09-02T10:00:00.000Z')
  const result = await sendDraftForUser(prisma, {
    organizationId: ORG, userId: USER, draftActionId: ACTION, holdMs: 15_000,
  }, {
    ...deps(routes(liveDraft())),
    fetchImpl: (async (url: string, init?: { method?: string }) => {
      if (url.includes('/drafts/') && (init?.method ?? 'GET') === 'GET') {
        now = new Date('2026-09-02T10:00:05.000Z')
      }
      return deps(routes(liveDraft())).fetchImpl(url, init)
    }) as never,
    now: () => now,
  })
  assert.equal(result.status, 'held')
  assert.deepEqual(result.sendAfter, new Date('2026-09-02T10:00:20.000Z'))
})

test('a stale validation cannot dispatch after a newer held claim', async () => {
  const { prisma, state } = makePrisma(row())
  let now = new Date('2026-09-02T10:00:00.000Z')
  let reads = 0
  let releaseFirst!: () => void
  const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve })
  const provider = {
    ...deps(routes(liveDraft())),
    fetchImpl: (async (url: string, init?: { method?: string }) => {
      if (url.includes('/drafts/') && (init?.method ?? 'GET') === 'GET' && ++reads === 1) {
        await firstRead
      }
      return deps(routes(liveDraft())).fetchImpl(url, init)
    }) as never,
    now: () => now,
  }
  const first = sendDraftForUser(prisma, { organizationId: ORG, userId: USER, draftActionId: ACTION }, provider)
  await new Promise((resolve) => setImmediate(resolve))
  state.row = { ...state.row, state: 'draft', claimedAt: null }
  now = new Date('2026-09-02T10:03:00.000Z')
  const newer = await sendDraftForUser(prisma, {
    organizationId: ORG, userId: USER, draftActionId: ACTION, holdMs: 15_000,
  }, provider)
  releaseFirst()
  await assert.rejects(first, (error: unknown) =>
    error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE')
  assert.equal(newer.status, 'held')
  assert.equal(state.row.state, 'sending')
  assert.equal(state.row.claimedAt, null)
})

test('a stale validation failure cannot roll back a newer held claim', async () => {
  const { prisma, state } = makePrisma(row())
  let now = new Date('2026-09-02T10:00:00.000Z')
  let reads = 0
  let releaseFirst!: () => void
  const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve })
  const provider = {
    ...deps(routes(liveDraft())),
    fetchImpl: (async (url: string, init?: { method?: string }) => {
      if (url.includes('/drafts/') && (init?.method ?? 'GET') === 'GET' && ++reads === 1) {
        await firstRead
        throw new Error('Gmail read failed')
      }
      return deps(routes(liveDraft())).fetchImpl(url, init)
    }) as never,
    now: () => now,
  }
  const first = sendDraftForUser(prisma, { organizationId: ORG, userId: USER, draftActionId: ACTION }, provider)
  await new Promise((resolve) => setImmediate(resolve))
  state.row = { ...state.row, state: 'draft', claimedAt: null }
  now = new Date('2026-09-02T10:03:00.000Z')
  await sendDraftForUser(prisma, {
    organizationId: ORG, userId: USER, draftActionId: ACTION, holdMs: 15_000,
  }, provider)
  releaseFirst()
  await assert.rejects(first, (error: unknown) =>
    error instanceof GmailDraftError && error.code === 'PROVIDER_FAILED')
  assert.equal(state.row.state, 'sending')
  assert.deepEqual(state.row.sendAfter, new Date('2026-09-02T10:03:15.000Z'))
})

test('an unconfirmed Gmail update locks later update and send attempts', async () => {
  const { prisma, state } = makePrisma(row())
  const providerFailure = {
    ...deps(routes(liveDraft())),
    fetchImpl: (async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT' && url.includes('/drafts/')) throw new Error('timed out after PUT')
      return deps(routes(liveDraft())).fetchImpl(url, init)
    }) as never,
  }
  await assert.rejects(
    updateDraftForUser(prisma, {
      organizationId: ORG, userId: USER, draftActionId: ACTION,
      message: { to: ['jana@example.com'], subject: 'Edited', body: 'Updated text.' },
    }, providerFailure),
    (error: unknown) => error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE',
  )
  assert.equal(state.row.state, 'update_unknown')
  await assert.rejects(updateDraftForUser(prisma, {
    organizationId: ORG, userId: USER, draftActionId: ACTION,
    message: { to: ['jana@example.com'], subject: 'Again', body: 'Again.' },
  }, deps(routes(liveDraft()))), GmailDraftError)
  await assert.rejects(sendDraftForUser(
    prisma, { organizationId: ORG, userId: USER, draftActionId: ACTION }, deps(routes(liveDraft())),
  ), GmailDraftError)
})

test('attachments and rich alternatives are refused before Gmail update or send', async () => {
  for (const payload of [
    {
      mimeType: 'multipart/mixed', parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Here it is.').toString('base64url') } },
        { filename: 'report.pdf', mimeType: 'application/pdf', body: { attachmentId: 'file-1', size: 5 } },
      ],
    },
    {
      mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Here it is.').toString('base64url') } },
        { mimeType: 'text/html', body: { data: Buffer.from('<b>Here it is.</b>').toString('base64url') } },
      ],
    },
  ]) {
    const draft = liveDraft({ message: { id: 'msg-1', threadId: 'thread-1', payload } })
    for (const operation of ['update', 'send'] as const) {
      const { prisma, state } = makePrisma(row())
      let mutations = 0
      const provider = {
        ...deps(routes(draft, () => { mutations += 1 })),
        fetchImpl: (async (url: string, init?: { method?: string }) => {
          if (init?.method === 'PUT') mutations += 1
          return deps(routes(draft, () => { mutations += 1 })).fetchImpl(url, init)
        }) as never,
      }
      const task = operation === 'update'
        ? updateDraftForUser(prisma, {
          organizationId: ORG, userId: USER, draftActionId: ACTION,
          message: { to: ['jana@example.com'], subject: 'Edited', body: 'Updated text.' },
        }, provider)
        : sendDraftForUser(prisma, { organizationId: ORG, userId: USER, draftActionId: ACTION }, provider)
      await assert.rejects(task, (error: unknown) =>
        error instanceof GmailDraftError && error.code === 'DRAFT_NOT_SENDABLE')
      assert.equal(mutations, 0)
      assert.equal(state.row.state, 'draft')
    }
  }
})

test('a reply update preserves its provider reply chain through final send', async () => {
  const replyHeaders = [
    { name: 'To', value: 'jana@example.com' }, { name: 'Subject', value: 'Quarterly update' },
    { name: 'In-Reply-To', value: '<parent@example.com>' },
    { name: 'References', value: '<root@example.com> <parent@example.com>' },
  ]
  const before = liveDraft({ message: {
    id: 'msg-1', threadId: 'thread-1', payload: { headers: replyHeaders, mimeType: 'text/plain', body: { data: Buffer.from('Here it is.').toString('base64url') } },
  } })
  const after = liveDraft({ message: {
    id: 'msg-2', threadId: 'thread-1', payload: { headers: replyHeaders, mimeType: 'text/plain', body: { data: Buffer.from('Updated.').toString('base64url') } },
  } })
  const { prisma, state } = makePrisma(row({ contentFingerprint: fingerprintDraft({
    to: ['jana@example.com'], subject: 'Quarterly update', body: 'Here it is.', inReplyTo: '<parent@example.com>',
    references: ['<root@example.com>', '<parent@example.com>'], threadId: 'thread-1', attachmentIds: [],
  }) }))
  let updated = false
  const raw: string[] = []
  const threadIds: string[] = []
  const fetchImpl = async (url: string, init?: { body?: string; method?: string }) => {
    if (init?.method === 'PUT') { updated = true; const request = JSON.parse(init.body ?? '{}'); raw.push(String(request.message.raw ?? '')); threadIds.push(String(request.message.threadId ?? '')); return { ok: true, status: 200, json: async () => after, text: async () => JSON.stringify(after) } }
    if (url.includes('/messages/send')) { const request = JSON.parse(init?.body ?? '{}'); raw.push(String(request.raw ?? '')); threadIds.push(String(request.threadId ?? '')); return { ok: true, status: 200, json: async () => ({ id: 'sent-1' }), text: async () => '{"id":"sent-1"}' } }
    if (init?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
    const draft = updated ? after : before
    return { ok: true, status: 200, json: async () => draft, text: async () => JSON.stringify(draft) }
  }
  await updateDraftForUser(prisma, {
    organizationId: ORG, userId: USER, draftActionId: ACTION,
    message: { to: ['jana@example.com'], subject: 'Quarterly update', body: 'Updated.' },
  }, { encryptionSecret: ENCRYPTION_SECRET, fetchImpl, now: () => new Date('2026-09-02T10:00:00.000Z') })
  assert.equal(state.row.state, 'draft')
  await sendDraftForUser(prisma, {
    organizationId: ORG, userId: USER, draftActionId: ACTION,
  }, { encryptionSecret: ENCRYPTION_SECRET, fetchImpl })
  for (const encoded of raw) {
    const message = Buffer.from(encoded, 'base64url').toString('utf8')
    assert.match(message, /In-Reply-To: <parent@example\.com>/)
    assert.match(message, /References: <root@example\.com> <parent@example\.com>/)
  }
  assert.deepEqual(threadIds, ['thread-1', 'thread-1'])
})
