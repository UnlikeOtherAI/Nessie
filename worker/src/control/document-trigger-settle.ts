import { Prisma, type PrismaClient } from '@prisma/client'
import {
  DocumentTriggerDeliveryPayloadSchema,
  documentTriggerDeliveryKeyPrefix,
  documentTriggerPendingKey,
  TRIGGER_DOCUMENT_DISPATCH_TOPIC,
  type DocumentTriggerDeliveryPayload,
  type DocumentTriggerSkipReason,
  type TriggerDocumentDispatchJobPayload,
} from '@nessie/schemas'

import { enqueueQueueJob } from '../queue.js'
import { recordTriggerRunFailure, upsertDelivery, type RetryContext } from './trigger-run.js'

/**
 * A document trigger's quiet window and its one delivery
 * (docs/standards/document-triggers.md → "One quiet window, one review"):
 * closing the window, opening the next when a save landed while this one was
 * decided, and settling the decision as exactly one delivery row.
 */

/**
 * The window closes: the next save opens a new one, whatever this job does.
 * Every save that joined this window row-locked the job holding its key
 * (`enqueueQueueJob` `onConflict: 'lock'`), so this waits for each of them to
 * commit — the page read that follows sees every save the window took in.
 */
export const releaseWindow = (prisma: PrismaClient, job: TriggerDocumentDispatchJobPayload) =>
  prisma.$executeRaw(Prisma.sql`
    UPDATE queue_jobs SET idempotency_key = NULL
     WHERE idempotency_key = ${documentTriggerPendingKey(job.triggerId, job.pageId)}
       AND topic = ${TRIGGER_DOCUMENT_DISPATCH_TOPIC}
  `)

/**
 * After a window was decided, a save that committed meanwhile — one that
 * started after the key was released and so opened no window of its own
 * because this job still held it, or one that raced the release — must not
 * go unreviewed: when the page's newest version moved past what this window
 * read, the next window opens now. Its key collapses into any window a save
 * already opened.
 */
export const openNextWindowIfMoved = async (
  prisma: PrismaClient,
  job: TriggerDocumentDispatchJobPayload,
  read: { fireOn: 'save' | 'publish'; quietSeconds: number; versionNumber: number },
): Promise<void> => {
  const trigger = await prisma.agentTrigger.findFirst({
    where: { id: job.triggerId, enabled: true, status: 'active' },
    select: { id: true },
  })
  if (!trigger) return
  const newest = read.fireOn === 'publish'
    ? (await prisma.knowledgePage.findUnique({
        where: { id: job.pageId },
        select: { publishedVersion: { select: { versionNumber: true } } },
      }))?.publishedVersion?.versionNumber
    : (await prisma.knowledgePageVersion.findFirst({
        where: { pageId: job.pageId },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      }))?.versionNumber
  if (newest === undefined || newest <= read.versionNumber) return
  await enqueueQueueJob(prisma, {
    delayMs: read.quietSeconds * 1_000,
    idempotencyKey: documentTriggerPendingKey(job.triggerId, job.pageId),
    payload: job,
    topic: TRIGGER_DOCUMENT_DISPATCH_TOPIC,
  })
}

/** How many times this page woke this trigger's agent in the last day. */
export const wakesInLastDay = (prisma: PrismaClient, triggerId: string, pageId: string): Promise<number> =>
  prisma.agentTriggerDelivery.count({
    where: {
      triggerId,
      status: 'delivered',
      dedupeKey: { startsWith: documentTriggerDeliveryKeyPrefix(triggerId, pageId) },
      deliveredAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1_000) },
    },
  })

export const settleStaleRetry = async (prisma: PrismaClient, retry: RetryContext | undefined): Promise<void> => {
  if (!retry?.reuseDeliveryId) return
  await prisma.agentTriggerDelivery.updateMany({
    where: { id: retry.reuseDeliveryId, status: 'failed' },
    data: { status: 'skipped', errorMessage: 'no_longer_applies', nextRetryAt: null },
  })
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

export type DocumentActOutcome =
  | { outcome: 'ticket_work' | 'page_thread'; workId?: string; threadId: string }
  | { skip: DocumentTriggerSkipReason }

export type DocumentAct = (tx: Prisma.TransactionClient, deliveryId: string) => Promise<DocumentActOutcome>

export const skipped = (
  base: Omit<DocumentTriggerDeliveryPayload, 'outcome'>,
  reason: DocumentTriggerSkipReason,
): DocumentTriggerDeliveryPayload => ({ ...base, outcome: 'skipped', skipReason: reason })

/**
 * One decision as one delivery row: a skip with its reason, or a delivery
 * beside what the route did, in one transaction. A throw rolls both back and
 * leaves a failed, retryable row — a classified authority loss (the agent out
 * of its channel) also moves the trigger's health.
 */
export const settleDocumentDelivery = async (
  prisma: PrismaClient,
  input: {
    triggerId: string
    dedupeKey: string
    payload: DocumentTriggerDeliveryPayload
    act?: DocumentAct
    retry?: RetryContext
  },
): Promise<void> => {
  if (!input.retry) {
    const existing = await prisma.agentTriggerDelivery.findFirst({
      where: { triggerId: input.triggerId, dedupeKey: input.dedupeKey },
      select: { id: true },
    })
    if (existing) return
  }
  try {
    await prisma.$transaction(async (tx) => {
      const delivery = await upsertDelivery(tx, {
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        retry: input.retry,
        source: 'document',
        triggerId: input.triggerId,
      })
      const acted = input.act ? await input.act(tx, delivery.id) : null
      if (!acted || 'skip' in acted) {
        const reason = acted?.skip ?? input.payload.skipReason ?? 'no_longer_applies'
        const payload = DocumentTriggerDeliveryPayloadSchema.parse({
          ...input.payload, outcome: 'skipped', skipReason: reason, workId: undefined, threadId: undefined,
        })
        await tx.agentTriggerDelivery.update({
          where: { id: delivery.id },
          data: { status: 'skipped', errorMessage: reason, nextRetryAt: null, payload },
        })
        return
      }
      const payload = DocumentTriggerDeliveryPayloadSchema.parse({
        ...input.payload,
        outcome: acted.outcome,
        ...(acted.workId ? { workId: acted.workId } : {}),
        threadId: acted.threadId,
      })
      await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: { status: 'delivered', deliveredAt: new Date(), errorMessage: null, payload },
      })
      await tx.agentTrigger.update({ where: { id: input.triggerId }, data: { lastFiredAt: new Date() } })
    })
  } catch (error) {
    // Another worker settled this window's change first.
    if (!input.retry && isUniqueViolation(error)) return
    await recordTriggerRunFailure(prisma, {
      dedupeKey: input.dedupeKey,
      error,
      payload: input.payload,
      retry: input.retry,
      source: 'document',
      triggerId: input.triggerId,
    })
  }
}
