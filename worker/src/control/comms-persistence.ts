import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import {
  decideEventPersistence,
  type NormalizedEvent,
  type SubscriptionDescriptor,
} from '@nessie/comms-connect'
import {
  buildCommsConnectorContext,
} from '@nessie/team-admin'

/**
 * Persistence + mapping helpers for the communications sync worker. Kept apart
 * from the job-orchestration loop (`comms-sync.ts`) so each file owns one
 * responsibility: this module only talks to Prisma and does the idempotent
 * normalized-event writes; the connector layer never sees the database.
 */

type CommsConnectionRow = Prisma.CommsConnectionGetPayload<{
  include: { credential: true }
}>

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/**
 * Decrypt a loaded connection + its credential into the connector-facing
 * context. Tokens are opened with the same shared secret-crypto seam that
 * sealed them; the plaintext never leaves the worker.
 */
export const toConnectorContext = buildCommsConnectorContext

const mapEventToCreateInput = (
  event: NormalizedEvent,
  params: { connectionId: string; organizationId: string },
  version: number,
): Prisma.CommsEventCreateInput => ({
  // `organization` now has a real FK, so the checked create takes the relation
  // rather than the bare scalar.
  organization: { connect: { id: params.organizationId } },
  connection: { connect: { id: params.connectionId } },
  canonicalMessageId: event.canonicalMessageId,
  version,
  isDeleted: event.isDeleted,
  editedAt: event.editedAt ? new Date(event.editedAt) : null,
  provider: event.provider,
  externalTenantId: event.externalTenantId,
  conversationId: event.conversationId,
  threadId: event.threadId ?? null,
  messageId: event.messageId,
  eventType: event.eventType,
  occurredAt: new Date(event.occurredAt),
  senderExternalId: event.senderExternalId ?? null,
  senderDisplayName: event.senderDisplayName ?? null,
  senderEmail: event.senderEmail ?? null,
  participants: event.participants as unknown as Prisma.InputJsonValue,
  subject: event.subject ?? null,
  contentText: event.contentText ?? null,
  contentHtml: event.contentHtml ?? null,
  attachments: event.attachments as unknown as Prisma.InputJsonValue,
  mentions: event.mentions as unknown as Prisma.InputJsonValue,
  reactions: event.reactions as unknown as Prisma.InputJsonValue,
  visibility: event.visibility,
  sourceUrl: event.sourceUrl ?? null,
  rawPayloadRef: event.rawPayloadRef ?? null,
})

export type PersistEventsResult = {
  inserted: number
  versioned: number
  skipped: number
  /**
   * The events that were genuinely new — not a new version of something already
   * stored, and not a duplicate. Arrival triggers fan out from this, so a
   * re-synced page cannot re-announce mail the person already saw.
   */
  insertedEvents: NormalizedEvent[]
}

/**
 * Idempotently persist a page of normalized events. For each canonical message
 * the latest stored version is read, {@link decideEventPersistence} chooses
 * insert-new / new-version / skip-duplicate, and the unique
 * `(connectionId, canonicalMessageId, version)` index makes a concurrent write
 * a benign skip.
 */
export const persistNormalizedEvents = async (
  prisma: Pick<PrismaClient, 'commsEvent'>,
  params: { connectionId: string; organizationId: string },
  events: readonly NormalizedEvent[],
): Promise<PersistEventsResult> => {
  const result: PersistEventsResult = {
    inserted: 0,
    versioned: 0,
    skipped: 0,
    insertedEvents: [],
  }
  for (const event of events) {
    const latest = await prisma.commsEvent.findFirst({
      where: {
        connectionId: params.connectionId,
        canonicalMessageId: event.canonicalMessageId,
      },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        isDeleted: true,
        editedAt: true,
        subject: true,
        contentText: true,
        contentHtml: true,
      },
    })
    const decision = decideEventPersistence(
      event,
      latest
        ? {
            version: latest.version,
            isDeleted: latest.isDeleted,
            editedAt: latest.editedAt?.toISOString(),
            subject: latest.subject ?? undefined,
            contentText: latest.contentText ?? undefined,
            contentHtml: latest.contentHtml ?? undefined,
          }
        : undefined,
    )
    if (decision.action === 'skip-duplicate') {
      result.skipped += 1
      continue
    }
    try {
      await prisma.commsEvent.create({
        data: mapEventToCreateInput(event, params, decision.version),
      })
      if (decision.action === 'insert-new') {
        result.inserted += 1
        result.insertedEvents.push(event)
      } else {
        result.versioned += 1
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        result.skipped += 1
        continue
      }
      throw error
    }
  }
  return result
}

/**
 * Upsert the webhook/watch subscriptions a connector reported, so the renewal
 * sweep can find them by `expiresAt`. Resource links are resolved by external
 * id within the connection.
 */
export const recordSubscriptions = async (
  prisma: Pick<PrismaClient, 'commsSubscription' | 'commsResource'>,
  connection: { id: string; provider: CommsConnectionRow['provider'] },
  descriptors: readonly SubscriptionDescriptor[],
): Promise<void> => {
  for (const descriptor of descriptors) {
    let resourceId: string | null = null
    if (descriptor.resourceExternalId) {
      const resource = await prisma.commsResource.findUnique({
        where: {
          connectionId_externalId: {
            connectionId: connection.id,
            externalId: descriptor.resourceExternalId,
          },
        },
        select: { id: true },
      })
      resourceId = resource?.id ?? null
    }
    await prisma.commsSubscription.upsert({
      where: {
        connectionId_externalSubscriptionId: {
          connectionId: connection.id,
          externalSubscriptionId: descriptor.externalSubscriptionId,
        },
      },
      create: {
        connectionId: connection.id,
        resourceId,
        provider: connection.provider,
        externalSubscriptionId: descriptor.externalSubscriptionId,
        clientState: descriptor.clientState ?? null,
        expiresAt: new Date(descriptor.expiresAt),
        status: 'active',
      },
      update: {
        resourceId,
        clientState: descriptor.clientState ?? null,
        expiresAt: new Date(descriptor.expiresAt),
        status: 'active',
      },
    })
  }
}
