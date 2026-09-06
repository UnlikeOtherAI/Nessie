import { createHash } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'

import type { PushRetryProvider } from './push-retry.js'

/**
 * The durable claim that makes a push send exactly-once.
 *
 * `push_deliveries` is an outcome log: it is written *after* a provider
 * answers, it carries no unique key, and ops prunes it on its own horizon, so
 * it can never answer "did we already send this?". Before this module a
 * redelivered `push.dispatch` job — a dropped ack during a drain, a lock
 * expiry, a nack-and-retry — simply sent the notification a second time, and
 * with N workers every drain and every scale-in could cause it
 * (horizontal-scaling audit 5.13).
 *
 * `claimPushSend` inserts one `push_send_claims` row before the provider is
 * called. The unique `(organization_id, notification_key, endpoint_key)` picks
 * exactly one winner; every later claimant loses the
 * `INSERT ... ON CONFLICT DO NOTHING` and **skips the send** — it does not fail
 * the job, because a job whose work was already done is a success.
 *
 * This is deliberately at-most-once per endpoint: the claim is taken before
 * the send and is never released, so a crash between claim and send drops that
 * one notification rather than risking a duplicate. Duplicates are the defect;
 * a missed notification is already recoverable from the durable `UserAlert`
 * row and the message itself.
 */

/** The Prisma surface the claim needs — one statement, no delegate. */
export type PushSendClaimPrisma = Pick<PrismaClient, '$executeRaw'>

export type PushClaimTransport = PushRetryProvider | 'webpush'

/**
 * Stable identity of one delivery endpoint. Hashed so no push token or
 * subscription endpoint is copied into a second table, and namespaced by
 * transport so a native token and a browser endpoint can never collide.
 *
 * Deliberately derived from the endpoint's own value rather than its row id:
 * a dead token that is pruned and re-registered gets a new row id, and a claim
 * keyed on that id would let the same notification reach the same device twice.
 */
export const pushEndpointKey = (
  transport: PushClaimTransport,
  endpoint: string,
): string => createHash('sha256').update(`${transport}:${endpoint}`).digest('hex')

export type ClaimPushSendInput = {
  organizationId: string
  /**
   * The notification's durable identity — never a clock reading or a random
   * value. It matches the enqueue idempotency key one-for-one
   * (`push:message:<id>`, `push:attention:<alertId>`), so the enqueue upsert and
   * this claim together give at-most-once per (notification, endpoint).
   */
  notificationKey: string
  /** {@link pushEndpointKey} over the device token / subscription endpoint. */
  endpointKey: string
  provider: PushClaimTransport
}

/**
 * Take the claim. Returns `true` for the one caller that may send, `false` for
 * every caller that arrives after it (including this same job on a redelivery).
 */
export const claimPushSend = async (
  prisma: PushSendClaimPrisma,
  input: ClaimPushSendInput,
): Promise<boolean> => {
  const inserted = await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO push_send_claims (
        id,
        organization_id,
        notification_key,
        endpoint_key,
        provider,
        claimed_at
      )
      VALUES (
        gen_random_uuid(),
        ${input.organizationId}::uuid,
        ${input.notificationKey},
        ${input.endpointKey},
        ${input.provider}::"PushProvider",
        now()
      )
      ON CONFLICT (organization_id, notification_key, endpoint_key) DO NOTHING
    `,
  )

  return Number(inserted) > 0
}
