import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  expiryForSendGrant,
  hasStandingSendAuthorization,
  resolveStandingConsentForToolCall,
} from '../src/send-authorization.js'

const ORG = '00000000-0000-4000-8000-000000000001'
const OWNER = '00000000-0000-4000-8000-000000000002'
const CONN = '00000000-0000-4000-8000-000000000003'
const AGENT = '00000000-0000-4000-8000-000000000004'

type FakeGrant = {
  expiresAt: Date | null
  revokedAt: Date | null
  mode?: 'always' | 'judged'
  boundary?: string | null
}

// A cast fake is unityped, so a column the query now selects is `undefined` at
// call time rather than a type error — `mode` and `boundary` must be modelled.
const prismaWith = (input: {
  connectionOwner?: string | null
  grant?: FakeGrant | null
  draftOwner?: string | null
}): PrismaClient => ({
  commsConnection: {
    findFirst: async () =>
      input.connectionOwner === null
        ? null
        : { ownerUserId: input.connectionOwner ?? OWNER },
    // A calendar call names no connection, so the resolver looks the caller's
    // Google accounts up; the fake must model that query too.
    findMany: async () => [{ id: CONN }],
  },
  sendAuthorizationGrant: {
    findUnique: async () =>
      input.grant
        ? {
            id: 'grant-1',
            mode: input.grant.mode ?? 'always',
            boundary: input.grant.boundary ?? null,
            expiresAt: input.grant.expiresAt,
            revokedAt: input.grant.revokedAt,
          }
        : null,
  },
  gmailDraftAction: {
    findFirst: async () =>
      input.draftOwner === null ? null : { connectionId: CONN },
  },
} as unknown as PrismaClient)

const base = {
  organizationId: ORG,
  connectionId: CONN,
  agentId: AGENT,
  requestingUserId: OWNER,
  interactive: true,
}

const live: FakeGrant = { expiresAt: null, revokedAt: null, mode: 'always' }

test('a live grant authorises an interactive send by the mailbox owner', async () => {
  assert.equal(
    await hasStandingSendAuthorization(prismaWith({ grant: live }), base),
    true,
  )
})

// The consent was given for "when I ask you to". A schedule is not a person
// asking, so it can never ride the grant.
test('an unattended run never rides a standing grant', async () => {
  assert.equal(
    await hasStandingSendAuthorization(prismaWith({ grant: live }), {
      ...base,
      interactive: false,
    }),
    false,
  )
})

test('a requester who is not the mailbox owner never rides the grant', async () => {
  assert.equal(
    await hasStandingSendAuthorization(
      prismaWith({ grant: live, connectionOwner: 'someone-else' }),
      base,
    ),
    false,
  )
})

test('a revoked or expired grant authorises nothing', async () => {
  assert.equal(
    await hasStandingSendAuthorization(
      prismaWith({ grant: { expiresAt: null, revokedAt: new Date() } }),
      base,
    ),
    false,
  )
  assert.equal(
    await hasStandingSendAuthorization(
      prismaWith({ grant: { expiresAt: new Date('2000-01-01'), revokedAt: null } }),
      base,
    ),
    false,
  )
})

test('no grant at all authorises nothing', async () => {
  assert.equal(
    await hasStandingSendAuthorization(prismaWith({ grant: null }), base),
    false,
  )
})

test('duration maps to an expiry, and forever to none', () => {
  const now = new Date('2026-09-02T10:00:00.000Z')
  assert.equal(expiryForSendGrant('forever', now), null)
  assert.deepEqual(
    expiryForSendGrant('10m', now),
    new Date('2026-09-02T10:10:00.000Z'),
  )
  assert.ok((expiryForSendGrant('30d', now) as Date) > now)
})

// ── the chokepoint resolver ─────────────────────────────────────────────────

const resolve = (
  toolName: string,
  args: Record<string, unknown>,
  prisma: PrismaClient = prismaWith({ grant: live }),
) =>
  resolveStandingConsentForToolCall(prisma, {
    toolName,
    args,
    organizationId: ORG,
    agentId: AGENT,
    requestingUserId: OWNER,
    interactive: true,
  })

// A calendar write is gated because it MAILS PEOPLE. With nobody to notify
// there is nothing to approve, and stopping the run to put lunch in your own
// diary made the calendar feel broken.
test('a calendar event with no guests needs no approval', async () => {
  assert.equal(
    (await resolve('calendar_event_create', { title: 'Lunch' })).outcome,
    'proceed',
  )
  assert.equal(
    (await resolve('calendar_event_create', { title: 'Lunch', attendees: [] })).outcome,
    'proceed',
  )
})

// The guestless short-circuit must not become a blanket exemption: with
// guests, the call reaches the grant like any other outbound action, and
// without a grant it asks.
test('a calendar event that invites someone asks when there is no grant', async () => {
  const noGrant = prismaWith({ grant: null })
  assert.equal(
    (await resolve(
      'calendar_event_create',
      { title: 'Review', attendees: ['jana@example.com'] },
      noGrant,
    )).outcome,
    'ask',
  )
  assert.equal(
    (await resolve(
      'calendar_event_update',
      { eventId: 'e1', attendees: ['jana@example.com'] },
      noGrant,
    )).outcome,
    'ask',
  )
})

test('a guestless event proceeds even with no grant at all', async () => {
  assert.equal(
    (await resolve('calendar_event_create', { title: 'Lunch' }, prismaWith({ grant: null })))
      .outcome,
    'proceed',
  )
})

// Cancelling notifies whoever was invited and the caller cannot prove there
// were none, so it never takes the guestless shortcut.
test('cancelling an event asks when there is no grant', async () => {
  assert.equal(
    (await resolve('calendar_event_cancel', { eventId: 'e1' }, prismaWith({ grant: null })))
      .outcome,
    'ask',
  )
})

test('an unknown gated tool falls through to the human gate', async () => {
  assert.equal((await resolve('some_future_tool', {})).outcome, 'ask')
})

test('a draft belonging to someone else grants nothing', async () => {
  assert.equal(
    (await resolve(
      'gmail_draft_send',
      { draftId: 'd1' },
      prismaWith({ grant: live, draftOwner: null }),
    )).outcome,
    'ask',
  )
})

test('a send with no draft id grants nothing', async () => {
  assert.equal((await resolve('gmail_draft_send', {})).outcome, 'ask')
})

test('an approval to ask freezes the one Google connection it resolved', async () => {
  const decision = await resolve(
    'gmail_draft_send',
    { draftId: 'd1' },
    prismaWith({ grant: null }),
  )
  assert.deepEqual(decision, { connectionId: CONN, outcome: 'ask' })
})

// A judged grant is consent to DECIDE, not consent to send: the caller must
// still run the boundary judge before anything leaves.
test('a judged grant returns the boundary to judge, never a bare proceed', async () => {
  const decision = await resolve(
    'gmail_draft_send',
    { draftId: 'd1' },
    prismaWith({
      grant: { expiresAt: null, revokedAt: null, mode: 'judged', boundary: 'Routine only.' },
    }),
  )
  assert.equal(decision.outcome, 'judge')
  if (decision.outcome === 'judge') {
    assert.equal(decision.boundary, 'Routine only.')
  }
})

test('a judged grant with no boundary asks rather than inventing one', async () => {
  assert.equal(
    (await resolve(
      'gmail_draft_send',
      { draftId: 'd1' },
      prismaWith({
        grant: { expiresAt: null, revokedAt: null, mode: 'judged', boundary: '   ' },
      }),
    )).outcome,
    'ask',
  )
})

test('an always grant proceeds without a judgement', async () => {
  assert.equal(
    (await resolve('gmail_draft_send', { draftId: 'd1' })).outcome,
    'proceed',
  )
})
