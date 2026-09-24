import type { PrismaClient } from '@prisma/client'
import {
  DOCUMENT_TRIGGER_PAGE_WAKES_PER_DAY,
  DocumentChangedStoredConfigSchema,
  DocumentTriggerDeliveryPayloadSchema,
  documentTriggerDeliveryKey,
  documentTriggerWatchesPage,
  type DocumentTriggerDeliveryPayload,
  type TriggerDocumentDispatchJobPayload,
} from '@nessie/schemas'
import { documentSpaceAudienceRefusal } from '@nessie/team-admin'

import {
  agentPageAccess,
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
import {
  openNextWindowIfMoved,
  releaseWindow,
  settleDocumentDelivery,
  settleStaleRetry,
  skipped,
  wakesInLastDay,
} from './document-trigger-settle.js'
import { recordTriggerHealthFailure } from './trigger-health.js'
import type { RetryContext } from './trigger-run.js'
import { createTicketWorkSeam } from './ticket-work.js'
import type { TicketWorkSeam } from './ticket-work-seam.js'

/**
 * `trigger.document.dispatch`: the end of one document trigger's quiet window
 * for one page (docs/standards/document-triggers.md).
 *
 * The window's key is released first (`releaseWindow`), so a save committed
 * after that opens the next window rather than vanishing into this one, and
 * every save that joined this window has committed by then. Then the page's
 * newest version (or its published one) is read, and everything after the
 * marker — the version the last delivery brought the agent up to — is one
 * change, decided once and settled as exactly one `agent_trigger_deliveries`
 * row, deduped on `doc:<triggerId>:<pageId>:<toVersionId>`:
 *
 * - the page left the trigger's scope, or was deleted: skipped with the reason;
 * - the agent can no longer read the space, or the space became narrower than
 *   the target channel: skipped **and the trigger paused with a health
 *   reason** — never a silent skip;
 * - this one page is narrower than its space (restricted, private to another
 *   agent): skipped `page_not_readable`, and the trigger keeps watching;
 * - no version that may wake the agent (`wakingVersions`): skipped, and the
 *   marker moves past them, so the agent never loops on agent edits;
 * - the page already woke the agent `DOCUMENT_TRIGGER_PAGE_WAKES_PER_DAY`
 *   times in a day: skipped `wake_limit`, the change still owed;
 * - otherwise the change is routed (`routeDocumentChange`): to the page's
 *   ticket's live work for this agent, or to the page's own review thread.
 *
 * Afterwards, a save that landed while this was decided opens the next window
 * (`openNextWindowIfMoved`).
 */

export type DocumentDispatchOptions = {
  seam?: TicketWorkSeam
  /** A retry of one failed delivery, reusing its row. */
  retry?: RetryContext
}

const ACCESS_LOST_REASON = 'document_trigger_access_lost'
const CONFIG_INVALID_REASON = 'document_trigger_config_invalid'

/** What a decided window read, for the check that a later save opens the next one. */
type WindowRead = { fireOn: 'save' | 'publish'; quietSeconds: number; versionNumber: number }

const decideWindow = async (
  prisma: PrismaClient,
  job: TriggerDocumentDispatchJobPayload,
  options: DocumentDispatchOptions,
): Promise<WindowRead | null> => {
  const trigger = await prisma.agentTrigger.findFirst({
    where: { id: job.triggerId, type: 'document_changed', agent: { organizationId: job.organizationId } },
    select: {
      id: true, agentId: true, enabled: true, status: true, config: true, targetChannelId: true, createdAt: true,
    },
  })
  const page = trigger ? await loadWatchedPage(prisma, job.organizationId, job.pageId) : null
  if (!trigger?.agentId || !trigger.enabled || trigger.status !== 'active' || !page) {
    await settleStaleRetry(prisma, options.retry)
    return null
  }
  const agentId = trigger.agentId
  const parsed = DocumentChangedStoredConfigSchema.safeParse(trigger.config)
  const fireOn = parsed.success ? parsed.data.fireOn : 'save'
  const quietSeconds = parsed.success ? parsed.data.quietSeconds : 0
  const to = await loadTargetVersion(prisma, page, fireOn)
  const from = await loadMarker(prisma, trigger.id, page.id) ?? await loadBaseline(prisma, page.id, trigger.createdAt)
  // Nothing after the marker: an earlier job already brought the agent here.
  if (!to || (from && from.number >= to.versionNumber)) {
    await settleStaleRetry(prisma, options.retry)
    return to ? { fireOn, quietSeconds, versionNumber: to.versionNumber } : null
  }
  const read: WindowRead = { fireOn, quietSeconds, versionNumber: to.versionNumber }
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
  const skip = (reason: Parameters<typeof skipped>[1]) =>
    settleDocumentDelivery(prisma, { ...common, payload: skipped(base, reason) })

  if (!parsed.success) {
    await skip('config_invalid')
    await recordTriggerHealthFailure(prisma, {
      error: {
        isReauthorizable: false,
        reason: CONFIG_INVALID_REASON,
        message: 'This document trigger\'s configuration no longer parses, so it matches nothing. '
          + 'Edit it on the Triggers page and choose its space again.',
      },
      triggerId: trigger.id,
    })
    return null
  }
  const config = parsed.data
  if (page.deletedAt) {
    await skip('page_gone')
    return null
  }
  if (page.status === 'archived' || !documentTriggerWatchesPage(config, await scopeFactsOf(prisma, page))) {
    await skip('out_of_scope')
    return null
  }
  const channel = trigger.targetChannelId
    ? await prisma.channel.findUnique({ where: { id: trigger.targetChannelId }, select: { label: true } })
    : null
  const narrower = documentSpaceAudienceRefusal(page.space, { label: channel?.label ?? 'its channel' })
  const access = page.space.deletedAt || narrower
    ? 'space_lost'
    : await agentPageAccess(prisma, { organizationId: job.organizationId, agentId, page })
  if (access === 'space_lost') {
    await skip('access_lost')
    await recordTriggerHealthFailure(prisma, {
      error: {
        isReauthorizable: false,
        reason: ACCESS_LOST_REASON,
        message: narrower
          ? `This document trigger watches a space that no longer suits its channel: ${narrower}. `
            + 'Widen the space or pick another, then resume the trigger.'
          : 'This document trigger\'s agent can no longer read the space it watches. '
            + 'Give the agent access again, then resume the trigger.',
      },
      triggerId: trigger.id,
    })
    return null
  }
  if (access === 'page_narrowed') {
    await skip('page_not_readable')
    return read
  }
  if (counts.counted.length === 0) {
    await skip('agent_edits_only')
    return read
  }
  if (await wakesInLastDay(prisma, trigger.id, page.id) >= DOCUMENT_TRIGGER_PAGE_WAKES_PER_DAY) {
    await skip('wake_limit')
    return read
  }

  const facts = changeFactsOf({ page, nameable: pageNameableInChannel(page, to), fireOn, from, to, counts })
  const payload: DocumentTriggerDeliveryPayload = { ...base, authorKinds: [...facts.authorKinds], outcome: 'page_thread' }
  await settleDocumentDelivery(prisma, {
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
  return read
}

export const dispatchDocumentChange = async (
  prisma: PrismaClient,
  job: TriggerDocumentDispatchJobPayload,
  options: DocumentDispatchOptions = {},
): Promise<void> => {
  if (!options.retry) await releaseWindow(prisma, job)
  const read = await decideWindow(prisma, job, options)
  if (!options.retry && read) await openNextWindowIfMoved(prisma, job, read)
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
