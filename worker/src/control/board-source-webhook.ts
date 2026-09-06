import type { PrismaClient } from '@prisma/client'
import {
  AdapterNotRegisteredError,
  type BoardSourceProvider,
  resolveBoardSourceAdapter,
} from '@nessie/board-sources'
import {
  applyInboundItem,
  type BoardWatchEvent,
  isBoardSourceCredentialError,
  loadBoardSourceConnectionContext,
  loadIdentityLinks,
  parseFieldMappings,
  parseStateMapping,
} from '@nessie/team-admin'

import type { BoardSourceSyncDeps } from './board-source-sync.js'

import { notifyBoardWatchers } from './board-watch-notify.js'

/**
 * A vendor webhook delivery.
 *
 * The intake route does nothing but enqueue: verification happens here, with
 * the deployment secret and the source's own token hash, so a forged delivery
 * costs one queued job and never reaches a provider call. Same split the
 * communications connector uses, for the same reason.
 */

export type BoardSourceWebhookJob = {
  provider: BoardSourceProvider
  headers: Record<string, string>
  rawBody: string
  token?: string
}

export const processBoardSourceWebhook = async (
  deps: BoardSourceSyncDeps,
  job: BoardSourceWebhookJob,
): Promise<{ applied: number; reason?: string }> => {
  const { prisma } = deps

  let adapter
  try {
    adapter = resolveBoardSourceAdapter(job.provider)
  } catch (cause) {
    if (cause instanceof AdapterNotRegisteredError) return { applied: 0, reason: 'not_configured' }
    throw cause
  }

  const request = {
    provider: job.provider,
    headers: job.headers,
    rawBody: job.rawBody,
    ...(job.token ? { token: job.token } : {}),
  }
  const delivery = adapter.parseWebhook(request)
  const sources = await findSourcesForDelivery(prisma, job, delivery.containerKey)
  if (sources.length === 0) return { applied: 0, reason: 'no_source' }

  let applied = 0
  for (const source of sources) {
    if (!adapter.verifyWebhook(request, { tokenHash: source.webhookTokenHash ?? undefined })) {
      // Not an error worth a health state: an unverifiable delivery is either a
      // forgery or a stale registration, and neither means the source is broken.
      continue
    }

    const context = await loadBoardSourceConnectionContext(
      prisma,
      source.connectionId,
      deps.encryptionSecret,
    )
    if (isBoardSourceCredentialError(context)) continue

    const container = source.container as Record<string, unknown>
    // The delivery carries ids; the item is re-read so the mirror is written
    // from the provider's current state rather than from a payload that may
    // already be behind another change.
    const items =
      delivery.externalIds.length > 0
        ? await adapter.fetchItems(context, container, delivery.externalIds)
        : []
    if (items.length === 0) continue

    const applyContext = {
      id: source.id,
      organizationId: source.organizationId,
      projectId: source.projectId,
      provider: source.provider,
      stateMapping: parseStateMapping(source.stateMapping),
      fieldMappings: parseFieldMappings(source.fieldMappings),
      identityByExternalUserId: await loadIdentityLinks(prisma, {
        organizationId: source.organizationId,
        provider: source.provider,
        externalTenantKey:
          source.provider === 'linear'
            ? source.connection.externalTenantId
            : source.provider === 'jira'
              ? String(container.cloudId ?? '')
              : source.provider,
      }),
    }

    const events: BoardWatchEvent[] = []
    for (const item of items) {
      const outcome = await applyInboundItem(prisma, applyContext, item)
      if (outcome.applied === 'created' || outcome.applied === 'updated') {
        applied += 1
        if (outcome.changes.length > 0) {
          events.push({
            taskId: outcome.taskId,
            projectId: source.projectId,
            organizationId: source.organizationId,
            fingerprint: outcome.fingerprint,
            changes: outcome.changes,
          })
        }
      }
    }

    // A webhook is "this one changed just now", which is the case a person asked
    // to hear about per ticket.
    await notifyBoardWatchers(prisma, events, { delivery: 'webhook' })

    if (applied > 0) {
      await deps.publishBoardUpdated({
        organizationId: source.organizationId,
        projectId: source.projectId,
      })
    }
  }
  return { applied }
}

/**
 * Which sources a delivery belongs to. A container key narrows it to the
 * sources reading that container; without one — a provider that does not say —
 * every source of that provider is a candidate and the signature decides.
 */
const findSourcesForDelivery = async (
  prisma: PrismaClient,
  job: BoardSourceWebhookJob,
  containerKey: string | null,
) =>
  prisma.boardSource.findMany({
    where: {
      provider: job.provider,
      healthState: { not: 'paused' },
      ...(containerKey ? { containerKey } : {}),
    },
    include: { connection: { select: { externalTenantId: true } } },
    take: 20,
  })
