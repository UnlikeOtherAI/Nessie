import { Prisma, type PrismaClient } from '@prisma/client'
import {
  DocumentChangedStoredConfigSchema,
  DocumentTriggerDeliveryPayloadSchema,
  documentTriggerDeliveryKey,
  documentTriggerPendingKey,
  documentTriggerWatchesPage,
  TRIGGER_DOCUMENT_DISPATCH_TOPIC,
  type DocumentTriggerDeliveryPayload,
  type DocumentTriggerSkipReason,
  type TriggerDocumentDispatchJobPayload,
} from '@nessie/schemas'
import { documentSpaceAudienceRefusal } from '@nessie/team-admin'

import {
  agentCanReadPage,
  changeFactsOf,
  countVersions,
  deliveryBaseOf,
  loadBaseline,
  loadMarker,
  loadTargetVersion,
  loadWatchedPage,
  pageNameableInChannel,
  scopeFactsOf,
} from './document-trigger-facts.js'
import { routeDocumentChange } from './document-trigger-route.js'
import { recordTriggerHealthFailure } from './trigger-health.js'
import { recordTriggerRunFailure, upsertDelivery, type RetryContext } from './trigger-run.js'
import { createTicketWorkSeam } from './ticket-work.js'
import type { TicketWorkSeam } from './ticket-work-seam.js'

/**
 * `trigger.document.dispatch`: the end of one document trigger's quiet window
 * for one page (docs/standards/document-triggers.md).
 *
 * The window's key is released first, so a save committed after that opens
 * the next window rather than vanishing into this one. Then the page's newest
 * version (or its published one) is read, and everything after the marker —
 * the version the last delivery brought the agent up to — is one change,
 * decided once and settled as exactly one `agent_trigger_deliveries` row,
 * deduped on `doc:<triggerId>:<pageId>:<toVersionId>`:
 *
 * - the page left the trigger's scope, or was deleted: skipped with the reason;
 * - the agent can no longer read the page or its space, or the space became
 *   narrower than the target channel: skipped **and the trigger paused with a
 *   health reason** — never a silent skip;
 * - only the agent's own saves (and, unless opted in, other agents'): skipped,
 *   and the marker moves past them, so the agent never loops on its own edits;
 * - otherwise the change is routed (`routeDocumentChange`): to the page's
 *   ticket's live work for this agent, or to the page's own review thread.
 */

export type DocumentDispatchOptions = {
  seam?: TicketWorkSeam
  /** A retry of one failed delivery, reusing its row. */
  retry?: RetryContext
}

const ACCESS_LOST_REASON = 'document_trigger_access_lost'
const CONFIG_INVALID_REASON = 'document_trigger_config_invalid'

/** The window closes: the next save opens a new one, whatever this job does. */
const releaseWindow = (prisma: PrismaClient, job: TriggerDocumentDispatchJobPayload) =>
  prisma.$executeRaw(Prisma.sql`
    UPDATE queue_jobs SET idempotency_key = NULL
     WHERE idempotency_key = ${documentTriggerPendingKey(job.triggerId, job.pageId)}
       AND topic = ${TRIGGER_DOCUMENT_DISPATCH_TOPIC}
  `)

const settleStaleRetry = async (prisma: PrismaClient, retry: RetryContext | undefined): Promise<void> => {
  if (!retry?.reuseDeliveryId) return
  await prisma.agentTriggerDelivery.updateMany({
    where: { id: retry.reuseDeliveryId, status: 'failed' },
    data: { status: 'skipped', errorMessage: 'no_longer_applies', nextRetryAt: null },
  })
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

export type DocumentAct = (
  tx: Prisma.TransactionClient,
  deliveryId: string,
) => Promise<{ outcome: 'ticket_work' | 'page_thread'; workId?: string; threadId: string } | { skip: DocumentTriggerSkipReason }>

/**
 * One decision as one delivery row: a skip with its reason, or a delivery
 * beside what the route did, in one transaction. A throw rolls both back and
 * leaves a failed, retryable row — a classified authority loss (the agent out
 * of its channel) also moves the trigger's health.
 */
const settle = async (
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

const skipped = (
  base: Omit<DocumentTriggerDeliveryPayload, 'outcome'>,
  reason: DocumentTriggerSkipReason,
): DocumentTriggerDeliveryPayload => ({ ...base, outcome: 'skipped', skipReason: reason })

export const dispatchDocumentChange = async (
  prisma: PrismaClient,
  job: TriggerDocumentDispatchJobPayload,
  options: DocumentDispatchOptions = {},
): Promise<void> => {
  if (!options.retry) await releaseWindow(prisma, job)
  const trigger = await prisma.agentTrigger.findFirst({
    where: { id: job.triggerId, type: 'document_changed', agent: { organizationId: job.organizationId } },
    select: {
      id: true, agentId: true, enabled: true, status: true, config: true, targetChannelId: true, createdAt: true,
    },
  })
  const page = trigger ? await loadWatchedPage(prisma, job.organizationId, job.pageId) : null
  if (!trigger?.agentId || !trigger.enabled || trigger.status !== 'active' || !page) {
    await settleStaleRetry(prisma, options.retry)
    return
  }
  const agentId = trigger.agentId
  const parsed = DocumentChangedStoredConfigSchema.safeParse(trigger.config)
  const fireOn = parsed.success ? parsed.data.fireOn : 'save'
  const to = await loadTargetVersion(prisma, page, fireOn)
  const from = await loadMarker(prisma, trigger.id, page.id) ?? await loadBaseline(prisma, page.id, trigger.createdAt)
  // Nothing after the marker: an earlier job already brought the agent here.
  if (!to || (from && from.number >= to.versionNumber)) {
    await settleStaleRetry(prisma, options.retry)
    return
  }
  const dedupeKey = documentTriggerDeliveryKey(trigger.id, page.id, to.id)
  // A retry whose window has since grown settles the old row and decides afresh.
  let retry = options.retry
  if (retry?.reuseDeliveryId) {
    const row = await prisma.agentTriggerDelivery.findUnique({
      where: { id: retry.reuseDeliveryId },
      select: { dedupeKey: true },
    })
    if (row?.dedupeKey !== dedupeKey) {
      await settleStaleRetry(prisma, retry)
      retry = undefined
    }
  }
  const counts = await countVersions(prisma, {
    organizationId: job.organizationId,
    projectId: page.projectId,
    agentId,
    config: parsed.success ? parsed.data : { includeAgentEdits: false },
    pageId: page.id,
    fromNumber: from?.number ?? 0,
    toNumber: to.versionNumber,
  })
  const base = {
    ...deliveryBaseOf({ page, fireOn, from, to, versionsCoalesced: counts.versions.length }),
    authorKinds: [],
  }
  const common = { triggerId: trigger.id, dedupeKey, ...(retry ? { retry } : {}) }

  if (!parsed.success) {
    await settle(prisma, { ...common, payload: skipped(base, 'config_invalid') })
    await recordTriggerHealthFailure(prisma, {
      error: {
        isReauthorizable: false,
        reason: CONFIG_INVALID_REASON,
        message: 'This document trigger\'s configuration no longer parses, so it matches nothing. '
          + 'Edit it on the Triggers page and choose its space again.',
      },
      triggerId: trigger.id,
    })
    return
  }
  const config = parsed.data
  if (page.deletedAt) {
    await settle(prisma, { ...common, payload: skipped(base, 'page_gone') })
    return
  }
  if (page.status === 'archived' || !documentTriggerWatchesPage(config, await scopeFactsOf(prisma, page))) {
    await settle(prisma, { ...common, payload: skipped(base, 'out_of_scope') })
    return
  }
  const channel = trigger.targetChannelId
    ? await prisma.channel.findUnique({ where: { id: trigger.targetChannelId }, select: { label: true } })
    : null
  const narrower = documentSpaceAudienceRefusal(page.space, { label: channel?.label ?? 'its channel' })
  if (page.space.deletedAt || narrower
    || !await agentCanReadPage(prisma, { organizationId: job.organizationId, agentId, page })) {
    await settle(prisma, { ...common, payload: skipped(base, 'access_lost') })
    await recordTriggerHealthFailure(prisma, {
      error: {
        isReauthorizable: false,
        reason: ACCESS_LOST_REASON,
        message: narrower
          ? `This document trigger watches a space that no longer suits its channel: ${narrower}. `
            + 'Widen the space or pick another, then resume the trigger.'
          : 'This document trigger\'s agent can no longer read a document it watches, or its space. '
            + 'Give the agent access again, then resume the trigger.',
      },
      triggerId: trigger.id,
    })
    return
  }
  if (counts.counted.length === 0) {
    await settle(prisma, { ...common, payload: skipped(base, 'agent_edits_only') })
    return
  }

  const facts = changeFactsOf({ page, nameable: pageNameableInChannel(page, to), fireOn, from, to, counts })
  const payload: DocumentTriggerDeliveryPayload = { ...base, authorKinds: [...facts.authorKinds], outcome: 'page_thread' }
  await settle(prisma, {
    ...common,
    payload,
    act: (tx, deliveryId) => routeDocumentChange(prisma, tx, {
      seam: options.seam ?? createTicketWorkSeam(prisma),
      trigger: {
        id: trigger.id, agentId, organizationId: job.organizationId, targetChannelId: trigger.targetChannelId,
      },
      config,
      page,
      facts,
      counts,
      at: to.createdAt,
      deliveryId,
    }),
  })
}

/**
 * The delivery-retry poller's arm for a document trigger: decide the page's
 * change again, for this trigger only, reusing the failed row.
 */
export const reattemptDocumentTriggerDelivery = async (
  prisma: PrismaClient,
  input: {
    organizationId: string | null
    payload: unknown
    retryCount: number
    reuseDeliveryId: string
    triggerId: string
  },
  options: Pick<DocumentDispatchOptions, 'seam'> = {},
): Promise<void> => {
  const parsed = DocumentTriggerDeliveryPayloadSchema.safeParse(input.payload)
  if (!parsed.success || !input.organizationId) {
    await prisma.agentTriggerDelivery.update({ where: { id: input.reuseDeliveryId }, data: { nextRetryAt: null } })
    return
  }
  await dispatchDocumentChange(
    prisma,
    { organizationId: input.organizationId, pageId: parsed.data.pageId, triggerId: input.triggerId },
    { ...options, retry: { reuseDeliveryId: input.reuseDeliveryId, retryCount: input.retryCount } },
  )
}
