import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { sealSecret } from '@nessie/comms-connect'
import { fingerprintDraft, sendDraftForUser } from '@nessie/team-admin'
import { sweepDueGmailSends, writeGmailDraftDispatchAudit } from '../src/control/gmail-send-sweep.js'

const ACTION = '00000000-0000-4000-8000-000000000001'
const ORGANIZATION = '00000000-0000-4000-8000-000000000002'
const USER = '00000000-0000-4000-8000-000000000003'
const CONNECTION = '00000000-0000-4000-8000-000000000004'
const ENCRYPTION_SECRET = 'worker-gmail-sweep-test-secret'
const NOW = new Date('2026-09-04T12:00:00.000Z')
const RECOVERY_AT = new Date(NOW.getTime() + 2 * 60 * 1000 + 1)

test('Gmail dispatch audits only the durable delivery state, never email content', async () => {
  const entries: Array<Record<string, unknown>> = []
  const writer = async (_prisma: PrismaClient, entry: Record<string, unknown>) => { entries.push(entry) }
  await writeGmailDraftDispatchAudit({} as PrismaClient, {
    action: 'gmail.draft.sent', id: ACTION, organizationId: ORGANIZATION,
  }, writer as never)
  await writeGmailDraftDispatchAudit({} as PrismaClient, {
    action: 'gmail.draft.delivery_unknown', id: ACTION, organizationId: ORGANIZATION,
  }, writer as never)
  assert.deepEqual(entries, [
    {
      action: 'gmail.draft.sent', actorId: 'gmail-draft-dispatch', actorType: 'system',
      metadata: { status: 'sent' }, organizationId: ORGANIZATION, outcome: 'success',
      requestId: `gmail-draft-dispatch:${ACTION}`, resourceId: ACTION, resourceType: 'gmail_draft_action',
    },
    {
      action: 'gmail.draft.delivery_unknown', actorId: 'gmail-draft-dispatch', actorType: 'system',
      metadata: { status: 'delivery_unknown' }, organizationId: ORGANIZATION, outcome: 'error',
      requestId: `gmail-draft-dispatch:${ACTION}`, resourceId: ACTION, resourceType: 'gmail_draft_action',
    },
  ])
})

test('an audit failure cannot affect the already-completed Gmail dispatch', async () => {
  await writeGmailDraftDispatchAudit({} as PrismaClient, {
    action: 'gmail.draft.sent', id: ACTION, organizationId: ORGANIZATION,
  }, async () => { throw new Error('audit unavailable') })
})

test('the periodic mail-send sweep also settles stale SMTP claims', async () => {
  const updates: unknown[] = []
  const prisma = {
    gmailDraftAction: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    mailboxSendAction: {
      findMany: async () => [{
        connectionId: '00000000-0000-4000-8000-000000000003', id: ACTION,
        organizationId: ORGANIZATION, ownerUserId: '00000000-0000-4000-8000-000000000004',
      }],
      updateMany: async (input: unknown) => { updates.push(input); return { count: 1 } },
    },
  } as unknown as PrismaClient
  await sweepDueGmailSends(prisma, {
    encryptionSecret: 'test-secret', now: () => new Date('2026-09-04T12:00:00.000Z'),
  })
  assert.match(JSON.stringify(updates), /delivery_unknown/)
})

test('a stale validation returns to draft and a published hold dispatches once', async () => {
  const action = {
    id: ACTION,
    organizationId: ORGANIZATION,
    ownerUserId: USER,
    connectionId: CONNECTION,
    providerDraftId: 'draft-1',
    providerThreadId: 'thread-1',
    contentFingerprint: fingerprintDraft({
      to: ['recipient@example.com'], subject: 'Immediate', body: 'Recover me', threadId: 'thread-1', attachmentIds: [],
    }),
    revision: 1,
    state: 'sending',
    // The durable post-claim state is not due while inline validation runs.
    sendAfter: null,
    claimedAt: NOW,
  }
  let sends = 0
  let sweepNow = NOW
  const response = (body: unknown) => ({
    ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
  })
  const prisma = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
      $executeRaw: async () => undefined,
      auditLog: { create: async () => undefined, findFirst: async () => null },
    }),
    auditLog: { create: async () => undefined, findFirst: async () => null },
    gmailDraftAction: {
      findMany: async ({ where }: { where: { state: string | { in: string[] } } }) => {
        if (typeof where.state !== 'string') return []
        return action.state === 'sending' && action.sendAfter !== null && action.sendAfter <= sweepNow
          ? [{ id: action.id, organizationId: action.organizationId }]
          : []
      },
      findUnique: async () => action,
      findUniqueOrThrow: async () => action,
      findFirst: async () => action,
      updateMany: async ({ where, data }: {
        where: {
          claimedAt?: Date | { lt: Date }
          sendAfter?: Date | null | { lte?: Date; not?: null }
          state?: string
        }
        data: Record<string, unknown>
      }) => {
        if (where.state && where.state !== action.state) return { count: 0 }
        if ('sendAfter' in where) {
          const expected = where.sendAfter
          if (expected === null || expected instanceof Date) {
            if (expected !== action.sendAfter) return { count: 0 }
          } else {
            // The sweep claims only a hold whose window has elapsed. Modelling
            // this predicate is what makes the undo-then-resend race testable:
            // ignoring it let the fake claim a re-armed validating row.
            if (!action.sendAfter) return { count: 0 }
            if (expected?.lte && action.sendAfter > expected.lte) return { count: 0 }
          }
        }
        if (where.claimedAt) {
          if (!action.claimedAt) return { count: 0 }
          if (where.claimedAt instanceof Date && action.claimedAt.getTime() !== where.claimedAt.getTime()) return { count: 0 }
          if (!(where.claimedAt instanceof Date) && action.claimedAt >= where.claimedAt.lt) return { count: 0 }
        }
        Object.assign(action, data)
        return { count: 1 }
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(action, data)
        return action
      },
    },
    mailboxSendAction: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    commsConnection: {
      findMany: async () => [{
        id: CONNECTION, status: 'active', grantedScopes: ['https://www.googleapis.com/auth/gmail.compose'], disabledCapabilities: [],
      }],
      findUnique: async () => ({
        id: CONNECTION, organizationId: ORGANIZATION, ownerUserId: USER, provider: 'google',
        externalTenantId: 'me@example.com', externalUserId: 'me@example.com',
        grantedScopes: ['https://www.googleapis.com/auth/gmail.compose'], credential: {
          accessTokenCiphertext: sealSecret(ENCRYPTION_SECRET, 'access-token'),
          refreshTokenCiphertext: null, expiresAt: new Date('2999-01-01T00:00:00.000Z'),
        },
      }),
    },
  } as unknown as PrismaClient
  const fetchImpl = async (url: string, init?: { method?: string }) => {
    if (url.includes('/messages/send')) {
      sends += 1
      return response({ id: 'sent-1' })
    }
    if (init?.method === 'DELETE') return response({})
    return response({
      id: 'draft-1', message: {
        id: 'message-1', threadId: 'thread-1', payload: {
          headers: [{ name: 'To', value: 'recipient@example.com' }, { name: 'Subject', value: 'Immediate' }],
          mimeType: 'text/plain', body: { data: Buffer.from('Recover me').toString('base64url') },
        },
      },
    })
  }

  const early = await sweepDueGmailSends(prisma, { encryptionSecret: ENCRYPTION_SECRET, now: () => sweepNow, fetchImpl } as never)
  sweepNow = RECOVERY_AT
  const recovered = await sweepDueGmailSends(prisma, { encryptionSecret: ENCRYPTION_SECRET, now: () => sweepNow, fetchImpl } as never)
  const retry = await sendDraftForUser(prisma, {
    organizationId: ORGANIZATION, userId: USER, draftActionId: ACTION, holdMs: 15_000,
  }, { encryptionSecret: ENCRYPTION_SECRET, fetchImpl, now: () => sweepNow })
  if (retry.status !== 'held') assert.fail('retry should publish a held send')
  sweepNow = retry.sendAfter
  const dispatched = await sweepDueGmailSends(prisma, { encryptionSecret: ENCRYPTION_SECRET, now: () => sweepNow, fetchImpl } as never)
  const second = await sweepDueGmailSends(prisma, { encryptionSecret: ENCRYPTION_SECRET, now: () => sweepNow, fetchImpl } as never)

  assert.deepEqual(early, { dispatched: 0, failed: 0, deliveryUnknown: 0 })
  assert.deepEqual(recovered, { dispatched: 0, failed: 0, deliveryUnknown: 0 })
  assert.deepEqual(dispatched, { dispatched: 1, failed: 0, deliveryUnknown: 0 })
  assert.deepEqual(second, { dispatched: 0, failed: 0, deliveryUnknown: 0 })
  assert.equal(sends, 1)
  assert.equal(action.state, 'sent')
})

test('the sweep cannot seize a validating row re-armed by undo and then resend', async () => {
  // The shape the guard exists for. A hold became due and the sweep selected
  // it; before dispatch the owner pressed Undo (sending -> draft) and sent
  // again, which claims draft -> sending with `sendAfter: null` while it
  // validates. Claiming on state alone let the sweep dispatch that row with no
  // undo window, and the owner's own request then failed while the mail went.
  const action = {
    id: ACTION,
    organizationId: ORGANIZATION,
    ownerUserId: USER,
    connectionId: CONNECTION,
    providerDraftId: 'draft-1',
    providerThreadId: 'thread-1',
    contentFingerprint: 'f'.repeat(64),
    revision: 1,
    state: 'sending',
    sendAfter: null,
    claimedAt: NOW,
  }
  let sends = 0
  const prisma = {
    gmailDraftAction: {
      findUnique: async () => action,
      findUniqueOrThrow: async () => action,
      findFirst: async () => action,
      updateMany: async ({ where, data }: {
        where: { sendAfter?: Date | null | { lte?: Date }; state?: string }
        data: Record<string, unknown>
      }) => {
        if (where.state && where.state !== action.state) return { count: 0 }
        if ('sendAfter' in where) {
          const expected = where.sendAfter
          if (expected === null || expected instanceof Date) {
            if (expected !== action.sendAfter) return { count: 0 }
          } else {
            if (!action.sendAfter) return { count: 0 }
            if (expected?.lte && action.sendAfter > expected.lte) return { count: 0 }
          }
        }
        Object.assign(action, data)
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient
  const fetchImpl = async (url: string) => {
    if (url.includes('/messages/send')) sends += 1
    return { ok: true, status: 200, json: async () => ({ id: 'sent-1' }), text: async () => '{}' }
  }

  const { dispatchClaimedDraft } = await import('@nessie/team-admin')
  await assert.rejects(
    () => dispatchClaimedDraft(prisma, ACTION, {
      encryptionSecret: ENCRYPTION_SECRET, fetchImpl, now: () => NOW,
    } as never),
    /draft not sendable/,
  )
  assert.equal(sends, 0, 'the sweep must not dispatch a row that is mid-validation')
  assert.equal(action.state, 'sending', 'the owner’s validating claim stays intact')
})
