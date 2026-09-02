import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { NormalizedEvent } from '@nessie/comms-connect'
import {
  parseOrganizationId,
  parseUserId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'

/** The topic the worker subscribes for event-trigger fan-out. */
const TRIGGER_EVENT_DISPATCH_TOPIC = 'trigger.event.dispatch'

/**
 * "Tell me when this arrives."
 *
 * A newly-arrived message becomes a `comms.email.received` event, which the
 * existing `event` trigger type already matches on — including its `filter`,
 * so a person can watch one sender or one subject without any new machinery.
 * This is deliberately NOT a new trigger type: `dispatchEventTriggers` was
 * built to fan out exactly this shape.
 *
 * Only the incremental path calls this. The initial history back-fill inserts
 * a whole mailbox, and firing a trigger per historical email would be a
 * thousand runs for a schedule somebody set up expecting one.
 */

export const EMAIL_RECEIVED_EVENT_TYPE = 'comms.email.received'

/** How many arrivals one sync page may fan out. */
const MAX_ARRIVAL_DISPATCHES = 25

export type ArrivalConnection = {
  id: string
  organizationId: string
  ownerUserId: string
  provider: string
  externalUserId: string
}

/**
 * The payload a trigger's `filter` can match on. Flat and scalar by design:
 * `matchesEventTriggerConfig` compares `payload[key] === value`, so a nested
 * object would be unmatchable.
 *
 * The message BODY is deliberately absent. A trigger payload is stored on the
 * delivery and read by whoever can see the trigger, so putting mail contents
 * here would leak a mailbox to anyone who can read the automation. The agent
 * fetches what it needs with the mailbox tools, under the run's own basis.
 */
const arrivalPayload = (
  connection: ArrivalConnection,
  event: NormalizedEvent,
): Record<string, unknown> => ({
  connectionId: connection.id,
  provider: connection.provider,
  mailbox: connection.externalUserId,
  from: event.senderEmail ?? '',
  fromName: event.senderDisplayName ?? '',
  subject: event.subject ?? '',
  threadId: event.threadId ?? event.conversationId,
  messageId: event.messageId,
  receivedAt: event.occurredAt,
  hasAttachments: (event.attachments ?? []).length > 0,
})

/**
 * The dispatcher reads only the organisation from this; each matching trigger
 * then builds its own run identity from its captured launch origin, which is
 * what keeps a schedule's authority its creator's rather than the mailbox's.
 */
const arrivalActorContext = (
  connection: ArrivalConnection,
): AuthorizedActionContext => ({
  actor: {
    actorId: connection.ownerUserId,
    actorType: 'user',
    roles: [],
  },
  actionContext: {
    effectiveUserId: parseUserId(connection.ownerUserId),
    purpose: 'comms.email.received',
    requestId: randomUUID(),
  },
  tenant: {
    organizationId: parseOrganizationId(connection.organizationId),
  },
})

/**
 * Fan newly-arrived messages out to matching event triggers.
 *
 * Best-effort by construction: a failure to enqueue must not fail the sync that
 * imported the mail — the mail is the durable part, the notification is not.
 */
export const dispatchEmailArrivals = async (
  prisma: PrismaClient,
  connection: ArrivalConnection,
  events: readonly NormalizedEvent[],
): Promise<number> => {
  const actorContext = arrivalActorContext(connection)
  const arrivals = events
    // A deletion tombstone and an edit are not arrivals.
    .filter((event) => !event.isDeleted && event.eventType === 'message')
    .slice(0, MAX_ARRIVAL_DISPATCHES)

  let dispatched = 0
  for (const event of arrivals) {
    try {
      await enqueueQueueJob(prisma, {
        topic: TRIGGER_EVENT_DISPATCH_TOPIC,
        payload: {
          actorContext,
          // At-least-once delivery plus a re-synced page means the same message
          // can be seen twice; the canonical id makes the second one a no-op.
          dedupeKey: `email-arrival:${connection.id}:${event.canonicalMessageId}`,
          eventType: EMAIL_RECEIVED_EVENT_TYPE,
          payload: arrivalPayload(connection, event),
          source: 'comms.sync',
        },
      })
      dispatched += 1
    } catch (error) {
      console.error(
        '[worker.email-arrival] could not dispatch arrival trigger',
        connection.id,
        error,
      )
    }
  }
  return dispatched
}
