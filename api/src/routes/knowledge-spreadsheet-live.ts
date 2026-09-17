import type { FastifyInstance } from 'fastify'
import { requestSpreadsheetPresence } from '@nessie/knowledge'

import { sendApiError } from '../lib/api.js'
import { buildStreamCorsHeaders } from '../lib/server-context.js'
import {
  requireKnowledgePolicy,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'
import {
  publishLeaveOnClose,
  type SpreadsheetRouteContext,
} from './knowledge-spreadsheets-context.js'

/**
 * The per-document live lane.
 *
 * One hijacked SSE route, one hub connection kind, one NOTIFY envelope kind.
 * Nothing durable rides it: there is no `Last-Event-ID`, no hydration and no
 * pending buffer, because the client bootstraps over REST *after* the stream
 * is open. The bootstrap carries `headSeq`, so anything the stream delivered
 * below it is discarded, anything above is applied in order, and a gap is
 * filled from `…/spreadsheet/ops?afterSeq=`.
 *
 * `teamHostBaseDomain` is passed to `buildStreamCorsHeaders` — without it a
 * client on a tenant host is refused by CORS and silently loses the lane
 * (PR #501 was exactly that bug on three other streams).
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/realtime-and-presence.md
 */
export const registerKnowledgeSpreadsheetLiveRoute = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
  context: SpreadsheetRouteContext,
): void => {
  const {
    config,
    allowedCorsOrigins,
    realtimeHub,
    requireActorContext,
    teamHostBaseDomain,
  } = deps
  const { service, access } = context

  app.get('/api/knowledge-base/pages/:pageId/live', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read'))) {
      return reply
    }
    const { pageId } = request.params as { pageId: string }
    const { clientId } = request.query as { clientId?: string }
    if (!clientId) {
      sendApiError(reply, 400, 'CLIENT_ID_REQUIRED', 'A clientId is required')
      return reply
    }
    if (actorContext.actor.actorType !== 'user') {
      // The lane is a browser surface. An agent writes through the REST door
      // and publishes its own presence; it has no socket to hold open, and
      // the delivery-time entitlement is written for a person.
      sendApiError(reply, 403, 'POLICY_DENIED', 'The live lane is for signed-in people')
      return reply
    }

    const page = await access.provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!page || page.kind !== 'spreadsheet') {
      sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Spreadsheet not found')
      return reply
    }
    const viewer = await access.buildViewer(actorContext)
    // The same helper the page routes use, so the lane inherits both halves of
    // the rule: the space grant *and* every-version-readable.
    if (!(await access.accessPageSpace(actorContext, page, viewer, 'read', reply))) return reply

    reply.hijack()
    reply.raw.writeHead(200, {
      ...buildStreamCorsHeaders({
        origin: request.headers.origin,
        allowedOrigins: allowedCorsOrigins,
        mode: config.mode,
        teamHostBaseDomain,
      }),
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      // Token-by-token delivery only survives if no hop buffers the response:
      // the proxy hint plus Nagle off, matching thread-stream.ts.
      'X-Accel-Buffering': 'no',
    })
    reply.raw.socket?.setNoDelay(true)
    reply.raw.write(': stream connected\n\n')

    const keepAlive = setInterval(() => {
      reply.raw.write(': keepalive\n\n')
    }, 15_000)

    const connection = realtimeHub.addDocumentConnection(
      {
        pageId,
        spaceId: page.spaceId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        clientId,
      },
      reply.raw,
    )

    request.raw.on('close', () => {
      clearInterval(keepAlive)
      realtimeHub.removeDocumentConnection(connection)
      // The socket closing is the only reliable signal that a pane went away —
      // a browser that crashed or lost power sends no `pagehide`.
      void publishLeaveOnClose(service, {
        organizationId: actorContext.tenant.organizationId,
        pageId,
        clientId,
      })
      reply.raw.end()
    })

    // Peers re-announce themselves, so a pane that joined late sees everybody
    // without waiting out their 10 s heartbeat.
    await requestSpreadsheetPresence(service, {
      organizationId: actorContext.tenant.organizationId,
      pageId,
    }).catch(() => undefined)

    return reply
  })
}
