import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { writeGmailDraftDispatchAudit } from '../src/control/gmail-send-sweep.js'

const ACTION = '00000000-0000-4000-8000-000000000001'
const ORGANIZATION = '00000000-0000-4000-8000-000000000002'

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
