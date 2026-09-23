import type { FastifyInstance } from 'fastify'
import { enqueueDeepWaterResearchEvent, resolveDeepWaterEventRun } from '@nessie/runtime'
import { DEEP_WATER_EVENT_ID_HEADER, DEEP_WATER_EVENT_SIGNATURE_HEADER } from '@nessie/schemas'

import { sendApiError } from '../../lib/api.js'
import type { RequestWithRawBody } from '../../lib/server-context.js'
import {
  authenticateDeepWaterEvent,
  readDeepWaterEventsSecret,
} from '../../services/deepwater-research-events.js'
import type { RouteDeps } from '../types.js'

/**
 * `POST /api/integrations/deep-water/events` — DeepWater's research events,
 * pushed straight from DeepWater for research Nessie asked for (Water plan
 * amendments-streaming S2). Public: the HMAC over the raw body is the
 * authentication, and there is no session.
 *
 * The receiver only decides whether the event is authentic and which run it
 * is about, queues it for the worker (`deep_water.research.event`, keyed by
 * the event id) and answers. It never changes a run itself.
 *
 * The answers are DeepWater's contract, not the `{data}` envelope of Nessie's
 * own API: `202 {accepted: true}` once queued; `200 {accepted: false, reason}`
 * for an authentic event that matches nothing Nessie can act on, so DeepWater
 * completes its delivery instead of retrying; 503 when the receiver has no key;
 * 401 for a signature that does not match or a stale `sent_at` (DeepWater
 * retries both); 400 for a body outside the contract (DeepWater drops it).
 */

export const DEEP_WATER_EVENTS_PATH = '/api/integrations/deep-water/events'

type ReceiverDeps = Pick<RouteDeps, 'prisma' | 'readFirstHeader'>

export const registerDeepWaterEventRoutes = (app: FastifyInstance, deps: ReceiverDeps): void => {
  const { prisma, readFirstHeader } = deps

  app.post(DEEP_WATER_EVENTS_PATH, { config: { public: true } }, async (request, reply) => {
    const secret = readDeepWaterEventsSecret()
    if (!secret) {
      sendApiError(
        reply,
        503,
        'DEEP_WATER_EVENTS_UNCONFIGURED',
        'DeepWater research events are not configured on this deployment.',
      )
      return reply
    }

    const authenticated = authenticateDeepWaterEvent({
      secret,
      rawBody: (request as RequestWithRawBody).rawBody,
      signature: readFirstHeader(request, [DEEP_WATER_EVENT_SIGNATURE_HEADER]) ?? null,
      eventIdHeader: readFirstHeader(request, [DEEP_WATER_EVENT_ID_HEADER]) ?? null,
      body: request.body,
      now: new Date(),
    })
    if (!authenticated.ok) {
      console.warn(
        `[deep-water] refused research event ${readFirstHeader(request, [DEEP_WATER_EVENT_ID_HEADER]) ?? '(no id)'}: `
        + `${authenticated.code}`,
      )
      const { code, details, message, status } = authenticated
      sendApiError(reply, status, code, message, undefined, details)
      return reply
    }
    const { event } = authenticated

    const resolution = await resolveDeepWaterEventRun(prisma, event)
    if (resolution.kind === 'refused') {
      console.info(
        `[deep-water] research event ${event.event_id} (${event.type}) for ${event.research.ledger_research_id} `
        + `not accepted: ${resolution.reason}`,
      )
      return reply.code(200).send({ accepted: false, reason: resolution.reason })
    }

    await enqueueDeepWaterResearchEvent(prisma, {
      organizationId: resolution.organizationId,
      runId: resolution.runId,
      event,
    })
    return reply.code(202).send({ accepted: true })
  })
}
