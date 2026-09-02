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

const prismaWith = (input: {
  connectionOwner?: string | null
  grant?: { expiresAt: Date | null; revokedAt: Date | null } | null
  draftOwner?: string | null
}): PrismaClient => ({
  commsConnection: {
    findFirst: async () =>
      input.connectionOwner === null
        ? null
        : { ownerUserId: input.connectionOwner ?? OWNER },
  },
  sendAuthorizationGrant: {
    findUnique: async () => input.grant ?? null,
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

const live = { expiresAt: null, revokedAt: null }

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
  assert.equal(await resolve('calendar_event_create', { title: 'Lunch' }), true)
  assert.equal(
    await resolve('calendar_event_create', { title: 'Lunch', attendees: [] }),
    true,
  )
})

test('a calendar event that invites someone still asks', async () => {
  assert.equal(
    await resolve('calendar_event_create', {
      title: 'Review',
      attendees: ['jana@example.com'],
    }),
    false,
  )
  assert.equal(
    await resolve('calendar_event_update', {
      eventId: 'e1',
      attendees: ['jana@example.com'],
    }),
    false,
  )
})

// Cancelling notifies whoever was invited, and the caller cannot prove there
// were none, so it always asks.
test('cancelling an event always asks', async () => {
  assert.equal(await resolve('calendar_event_cancel', { eventId: 'e1' }), false)
})

test('an unknown gated tool falls through to the human gate', async () => {
  assert.equal(await resolve('some_future_tool', {}), false)
})

test('a draft belonging to someone else grants nothing', async () => {
  assert.equal(
    await resolve(
      'gmail_draft_send',
      { draftId: 'd1' },
      prismaWith({ grant: live, draftOwner: null }),
    ),
    false,
  )
})

test('a send with no draft id grants nothing', async () => {
  assert.equal(await resolve('gmail_draft_send', {}), false)
})
