import type { PrismaClient } from '@prisma/client'
import {
  ConnectorNotRegisteredError,
  resolveConnector,
  type NormalizedEvent,
  type WebhookRequest,
} from '@nessie/comms-connect'
import type { CommsWebhookProcessJobPayload } from '@nessie/schemas'

import { persistNormalizedEvents } from './comms-persistence.js'
import { enqueueCommsIncrementalSync } from '../queue.js'

/**
 * Worker side of the Individual Communications Connector webhook path. The
 * public API route answers the provider fast (200) and enqueues the raw
 * delivery; this handler resolves the connector, verifies + normalizes it via
 * the adapter's `processWebhook`, persists the resulting events idempotently,
 * and nudges an incremental sync for the affected connection(s).
 *
 * Invalid or unresolvable deliveries are logged and dropped (never rethrown) so
 * a malformed payload cannot trigger a provider retry storm.
 *
 * Connection resolution is by `(provider, externalTenantId)` because the
 * adapter's `processWebhook` is provider-scoped and cannot see Nessie's
 * per-user connections. To avoid writing another user's message into a store
 * where the owner may not have visibility, returned events are persisted only
 * when exactly one active connection matches the tenant; when several users
 * share the tenant, every matching connection is nudged to run its own
 * token-gated incremental sync (the authoritative, visibility-safe path) and no
 * blind cross-user persist happens.
 */
export type CommsWebhookDeps = {
  prisma: PrismaClient
}

const parseBody = (rawBody: string): unknown => {
  try {
    return JSON.parse(rawBody)
  } catch {
    return undefined
  }
}

const groupByTenant = (
  events: readonly NormalizedEvent[],
): Map<string, NormalizedEvent[]> => {
  const byTenant = new Map<string, NormalizedEvent[]>()
  for (const event of events) {
    const bucket = byTenant.get(event.externalTenantId)
    if (bucket) {
      bucket.push(event)
    } else {
      byTenant.set(event.externalTenantId, [event])
    }
  }
  return byTenant
}

export const processCommsWebhookJob = async (
  deps: CommsWebhookDeps,
  payload: CommsWebhookProcessJobPayload,
): Promise<void> => {
  const { prisma } = deps

  let connector
  try {
    connector = resolveConnector(payload.provider)
  } catch (error) {
    if (error instanceof ConnectorNotRegisteredError) {
      console.warn(`[comms-webhook] ${error.message} — delivery dropped`)
      return
    }
    throw error
  }

  const request: WebhookRequest = {
    headers: payload.headers,
    query: payload.query,
    body: parseBody(payload.rawBody),
    rawBody: payload.rawBody,
  }

  let events: NormalizedEvent[]
  try {
    events = await connector.processWebhook(request)
  } catch (error) {
    // A failed signature check or malformed payload is expected hostile/noisy
    // traffic — drop it, do not retry.
    console.warn(
      `[comms-webhook] processWebhook failed for ${payload.provider}`,
      error instanceof Error ? error.message : String(error),
    )
    return
  }

  if (events.length === 0) {
    return
  }

  const byTenant = groupByTenant(events)
  const incrementalWindowMs = 30 * 1000
  const bucket = Math.floor(Date.parse(payload.receivedAt) / incrementalWindowMs)

  for (const [externalTenantId, tenantEvents] of byTenant) {
    const connections = await prisma.commsConnection.findMany({
      where: {
        provider: payload.provider,
        externalTenantId,
        status: { not: 'disconnected' },
      },
      select: { id: true, organizationId: true },
    })
    if (connections.length === 0) {
      continue
    }

    const sole = connections.length === 1 ? connections[0] : undefined
    if (sole) {
      await persistNormalizedEvents(
        prisma,
        { connectionId: sole.id, organizationId: sole.organizationId },
        tenantEvents,
      )
    }

    for (const connection of connections) {
      await enqueueCommsIncrementalSync(
        prisma,
        { connectionId: connection.id },
        `comms-webhook-incremental:${connection.id}:${bucket}`,
      )
    }
  }
}
