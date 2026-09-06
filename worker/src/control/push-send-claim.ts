import { createHash } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'

import type { PushRetryProvider } from './push-retry.js'

/**
 * The durable claim that stops a redelivered push job notifying a device twice
 * — without silencing a notification that was never actually sent.
 *
 * `push_deliveries` is an outcome log: it is written *after* a provider
 * answers, it carries no unique key, and ops prunes it on its own horizon, so
 * it can never answer "did we already send this?". Before this module a
 * redelivered `push.dispatch` job — a dropped ack during a drain, a lock
 * expiry, a nack-and-retry — simply sent the notification a second time, and
 * with N workers every drain and every scale-in could cause it
 * (horizontal-scaling audit 5.13).
 *
 * ## The claim has a state, and only one of them is permanent
 *
 * A claim taken and never released would be at-most-once, and that is not a
 * trade every notification can make. An incoming call fans out
 * `push:call:ring:<callId>:<userId>:<revision>`; if the provider errors through
 * every attempt and the job is later redelivered with the provider healthy, a
 * permanent claim means the endpoint is skipped and **the callee's phone never
 * rings**. A ring has no in-app surface that rings later, and a re-ring at the
 * same revision reuses the same key, so nothing retries it. `push:budget:*` has
 * the same hole.
 *
 * So the claim is a small state machine:
 *
 * - {@link claimPushSend} inserts `sending` *before* the provider is called.
 * - {@link markPushSendSent} promotes it to `sent` on a confirmed accept.
 *   `sent` is permanent and is the state that makes a duplicate impossible.
 * - {@link releasePushSendClaim} deletes it on a definitive failure or a thrown
 *   send, so the next redelivery genuinely retries.
 * - A `sending` row whose process was killed between the claim and the send is
 *   taken over by the next claimant once it is older than
 *   {@link PUSH_SEND_CLAIM_STALE_MS} — inside the claim statement itself, as an
 *   `ON CONFLICT DO UPDATE ... WHERE`, never a read-then-write.
 *
 * ## The guarantee, stated honestly
 *
 * **A send a provider accepted is never sent again.** It is deliberately not
 * exactly-once: past the stale horizon a genuinely in-flight send could be sent
 * a second time, and a process that dies after the provider accepted but before
 * {@link markPushSendSent} lands leaves a `sending` row a later delivery will
 * re-send. A duplicate ring is annoying; a ring that never happens is a missed
 * call, so this is the right way round.
 */

/** The Prisma surface the claim needs — single statements, no delegate. */
export type PushSendClaimPrisma = Pick<PrismaClient, '$executeRaw'>

export type PushClaimTransport = PushRetryProvider | 'webpush'

/**
 * How old a `sending` claim must be before another claimant may take it over.
 *
 * Bounded from below by the longest *legitimate* single-endpoint send:
 * `sendWithRetry` runs `PUSH_MAX_SEND_ATTEMPTS` (3) attempts with a sub-second
 * backoff plus provider round-trips, so seconds — two minutes leaves two orders
 * of magnitude of headroom and a live send is never taken over. Bounded from
 * above by the queue's own lock TTL (`DEFAULT_LOCK_TTL_SECONDS`, 300 s in
 * `packages/runtime/src/queue.ts`), which is how long a killed worker's job sits
 * before anybody else can have it: a horizon at or beyond that would mean the
 * first redelivery after a kill still finds the claim "fresh", skips the
 * endpoint and acks — exactly the silent loss this exists to prevent.
 *
 * Two minutes is also inside the window where a missed ring or budget alert
 * still means something to the person it was for.
 */
export const PUSH_SEND_CLAIM_STALE_MS = 120_000

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

/** Identifies one (notification, endpoint) claim. */
export type PushSendClaimRef = {
  organizationId: string
  /**
   * The notification's durable identity — never a clock reading or a random
   * value. It matches the enqueue idempotency key one-for-one
   * (`push:message:<id>`, `push:attention:<alertId>`), so the enqueue upsert and
   * this claim together stop one notification reaching a device twice.
   */
  notificationKey: string
  /** {@link pushEndpointKey} over the device token / subscription endpoint. */
  endpointKey: string
}

export type ClaimPushSendInput = PushSendClaimRef & {
  provider: PushClaimTransport
}

/**
 * Take the claim. Returns `true` for the one caller that may send, `false` for
 * every caller that arrives while another attempt is still live or after one
 * has succeeded.
 *
 * One statement does both jobs. The insert wins when nothing has claimed this
 * (notification, endpoint) yet; the `DO UPDATE` arm wins when a stale `sending`
 * row is taken over, and re-stamps `claimed_at` so the take-over's own age
 * starts now. A `sent` row satisfies neither, so it blocks forever — that is
 * the duplicate guard.
 */
export const claimPushSend = async (
  prisma: PushSendClaimPrisma,
  input: ClaimPushSendInput,
): Promise<boolean> => {
  const staleAfterSeconds = PUSH_SEND_CLAIM_STALE_MS / 1000
  const claimed = await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO push_send_claims (
        id,
        organization_id,
        notification_key,
        endpoint_key,
        provider,
        state,
        claimed_at
      )
      VALUES (
        gen_random_uuid(),
        ${input.organizationId}::uuid,
        ${input.notificationKey},
        ${input.endpointKey},
        ${input.provider}::"PushProvider",
        'sending'::"PushSendClaimState",
        now()
      )
      ON CONFLICT (organization_id, notification_key, endpoint_key) DO UPDATE
        SET state = 'sending'::"PushSendClaimState",
            provider = EXCLUDED.provider,
            claimed_at = now()
        WHERE push_send_claims.state = 'sending'::"PushSendClaimState"
          AND push_send_claims.claimed_at
              < now() - make_interval(secs => ${staleAfterSeconds}::double precision)
    `,
  )

  return Number(claimed) > 0
}

/**
 * Make the claim permanent. Called only once a provider has *accepted* the
 * send; from here on every redelivery skips this endpoint.
 */
export const markPushSendSent = async (
  prisma: PushSendClaimPrisma,
  ref: PushSendClaimRef,
): Promise<void> => {
  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE push_send_claims
      SET state = 'sent'::"PushSendClaimState"
      WHERE organization_id = ${ref.organizationId}::uuid
        AND notification_key = ${ref.notificationKey}
        AND endpoint_key = ${ref.endpointKey}
    `,
  )
}

/**
 * Give the claim back after a send that definitively did not happen, so the
 * next redelivery of the job retries it instead of skipping a device nothing
 * ever reached.
 *
 * Scoped to `sending` on purpose: a row already promoted to `sent` is a
 * completed delivery and must survive. It is not additionally fenced against a
 * stale take-over — a caller could in principle delete a take-over's fresh
 * `sending` row — because reaching that state needs one endpoint's send to hang
 * past {@link PUSH_SEND_CLAIM_STALE_MS} *and* the queue lock to lapse
 * underneath it, and the only consequence is one further attempt at a
 * notification that has not been delivered yet.
 */
export const releasePushSendClaim = async (
  prisma: PushSendClaimPrisma,
  ref: PushSendClaimRef,
): Promise<void> => {
  await prisma.$executeRaw(
    Prisma.sql`
      DELETE FROM push_send_claims
      WHERE organization_id = ${ref.organizationId}::uuid
        AND notification_key = ${ref.notificationKey}
        AND endpoint_key = ${ref.endpointKey}
        AND state = 'sending'::"PushSendClaimState"
    `,
  )
}
