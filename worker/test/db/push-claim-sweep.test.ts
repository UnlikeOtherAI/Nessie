import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import {
  PUSH_SEND_CLAIM_RETENTION_MS,
  sweepExpiredPushSendClaims,
} from '../../src/control/push-claim-sweep.js'
import { runDatabaseTest } from './support.js'

// Nothing else removes a `push_send_claims` row: a `sent` claim is permanent by
// design and a failed one is deleted on the spot, so without this reaper the
// table and its unique index grow forever — one row per notification per
// endpoint, tens of thousands a day for an active organisation.
//
// This lives in `test/db/` because the reaper is one SQL statement over a real
// table with a real interval; an in-memory fake would only re-assert the
// predicate this file exists to check. It drives no global poller, so it needs
// no `assertGlobalQueuesQuiet`, and it asserts only on claims it seeded itself.

const RETENTION_HOURS = PUSH_SEND_CLAIM_RETENTION_MS / 3_600_000

const insertClaim = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    notificationKey: string
    ageHours: number
    state: 'sending' | 'sent'
  },
): Promise<void> => {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO push_send_claims (
      id, organization_id, notification_key, endpoint_key, provider, state, claimed_at
    )
    VALUES (
      gen_random_uuid(),
      ${input.organizationId}::uuid,
      ${input.notificationKey},
      ${`endpoint-${randomUUID()}`},
      'apns'::"PushProvider",
      ${input.state}::"PushSendClaimState",
      now() - make_interval(hours => ${input.ageHours}::int)
    )
  `)
}

runDatabaseTest('the reaper removes only claims past the retention horizon', async () => {
  const prisma = new PrismaClient()
  const organization = await prisma.organization.create({
    data: { name: `push-claim-sweep ${randomUUID()}` },
  })
  try {
    // Straddle the horizon in both states: an expired claim can never be
    // legitimately consulted again (every notification key embeds a message id,
    // a ring revision or a period start), while anything inside it may still be
    // the guard for a job the queue has not finished redelivering.
    await insertClaim(prisma, {
      ageHours: RETENTION_HOURS + 1,
      notificationKey: 'push:message:expired-sent',
      organizationId: organization.id,
      state: 'sent',
    })
    await insertClaim(prisma, {
      ageHours: RETENTION_HOURS + 1,
      notificationKey: 'push:message:expired-sending',
      organizationId: organization.id,
      state: 'sending',
    })
    await insertClaim(prisma, {
      ageHours: RETENTION_HOURS - 1,
      notificationKey: 'push:message:inside-horizon',
      organizationId: organization.id,
      state: 'sent',
    })
    await insertClaim(prisma, {
      ageHours: 0,
      notificationKey: 'push:message:fresh',
      organizationId: organization.id,
      state: 'sending',
    })

    await sweepExpiredPushSendClaims(prisma)

    const surviving = await prisma.pushSendClaim.findMany({
      where: { organizationId: organization.id },
      orderBy: { notificationKey: 'asc' },
      select: { notificationKey: true },
    })
    assert.deepEqual(
      surviving.map((claim) => claim.notificationKey),
      ['push:message:fresh', 'push:message:inside-horizon'],
      'only claims past the horizon are removed, whatever state they are in',
    )
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.$disconnect()
  }
})
