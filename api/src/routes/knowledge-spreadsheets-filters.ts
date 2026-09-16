import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  clearSpreadsheetFilter,
  createSpreadsheetSnapshot,
  getSpreadsheetFilters,
  publishSpreadsheetPresence,
  publishSpreadsheetPresenceLeave,
  reapplySpreadsheetFilter,
  setSpreadsheetFilter,
  type KnowledgePageRecord,
} from '@nessie/knowledge'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  requestIds,
  requireKnowledgePolicy,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'
import {
  sendSpreadsheetError,
  spreadsheetActorFor,
  spreadsheetAttribution,
  type SpreadsheetRouteContext,
} from './knowledge-spreadsheets-context.js'

/**
 * Filters, named versions and presence.
 *
 * Split from `knowledge-spreadsheets.ts` for the 500-line budget, not because
 * they are a different concern: they take the same grants, through the same
 * `openPage` helper, which is handed in so there is exactly one definition of
 * "load a spreadsheet and enforce its space".
 */

const NamedVersionBodySchema = z.object({
  changeComment: z.string().min(1).max(500),
})

const PresenceBodySchema = z.object({
  frame: z.unknown(),
})

/** Loads a spreadsheet page and enforces the space's read or write grant. */
export type OpenSpreadsheetPage = (
  actorContext: AuthorizedActionContext,
  pageId: string,
  mode: 'read' | 'write',
  reply: FastifyReply,
) => Promise<{ page: KnowledgePageRecord; canWrite: boolean } | null>

export const registerKnowledgeSpreadsheetFilterRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
  context: SpreadsheetRouteContext,
  openPage: OpenSpreadsheetPage,
): void => {
  const { prisma, requireActorContext } = deps
  const { service } = context

  // ─── Filters ──────────────────────────────────────────────────────────────
  const filterParams = (request: { params: unknown }) => {
    const { pageId, sheet } = request.params as { pageId: string; sheet: string }
    return { pageId, sheet: Number(sheet) }
  }

  app.get('/api/knowledge-base/pages/:pageId/spreadsheet/filters/:sheet', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read'))) return reply
    const { pageId, sheet } = filterParams(request)
    if (!(await openPage(actorContext, pageId, 'read', reply))) return reply
    try {
      const filters = await getSpreadsheetFilters(service, {
        organizationId: actorContext.tenant.organizationId,
        pageId,
      })
      return createApiResponse({ sheet, filter: filters[String(sheet)] ?? null })
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  type FilterWriteInput = {
    organizationId: string
    pageId: string
    sheet: number
    who: {
      actor: Awaited<ReturnType<typeof spreadsheetActorFor>>
      attribution: ReturnType<typeof spreadsheetAttribution>
    }
  }

  // Set, clear and re-apply differ only in the service call: everything before
  // it — the actor, the policy gate, the space's write grant — is the same
  // three checks in the same order, and writing them out three times is how
  // one of them ends up missing from one route.
  const filterWriter = (run: (input: FilterWriteInput, body: unknown) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit'))) return reply
      const { pageId, sheet } = filterParams(request)
      if (!(await openPage(actorContext, pageId, 'write', reply))) return reply
      try {
        return createApiResponse(
          await run(
            {
              organizationId: actorContext.tenant.organizationId,
              pageId,
              sheet,
              who: {
                actor: await spreadsheetActorFor(deps, actorContext),
                attribution: spreadsheetAttribution(actorContext),
              },
            },
            request.body,
          ),
        )
      } catch (error) {
        return sendSpreadsheetError(reply, error)
      }
    }

  app.put(
    '/api/knowledge-base/pages/:pageId/spreadsheet/filters/:sheet',
    filterWriter((input, body) => setSpreadsheetFilter(service, { ...input, model: body })),
  )
  app.delete(
    '/api/knowledge-base/pages/:pageId/spreadsheet/filters/:sheet',
    filterWriter((input) => clearSpreadsheetFilter(service, input)),
  )
  app.post(
    '/api/knowledge-base/pages/:pageId/spreadsheet/filters/:sheet/reapply',
    filterWriter((input) => reapplySpreadsheetFilter(service, input)),
  )

  // ─── Named versions ───────────────────────────────────────────────────────
  app.post('/api/knowledge-base/pages/:pageId/spreadsheet/versions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit'))) return reply
    const body = parseInput(NamedVersionBodySchema, request.body, reply)
    if (!body) return reply
    const { pageId } = request.params as { pageId: string }
    if (!(await openPage(actorContext, pageId, 'write', reply))) return reply
    try {
      const snapshot = await createSpreadsheetSnapshot(service, {
        organizationId: actorContext.tenant.organizationId,
        pageId,
        actor: await spreadsheetActorFor(deps, actorContext),
        attribution: spreadsheetAttribution(actorContext),
        reason: 'named',
        changeComment: `named: ${body.changeComment}`,
      })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.spreadsheet.snapshot',
        resourceType: 'knowledge_page',
        resourceId: pageId,
        outcome: 'success',
        metadata: { versionId: snapshot.versionId, seq: snapshot.seq, reason: 'named' },
        ...requestIds(request),
      })
      return reply.code(201).send(createApiResponse(snapshot))
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  // ─── Presence ─────────────────────────────────────────────────────────────
  app.post('/api/knowledge-base/pages/:pageId/presence', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read'))) return reply
    const body = parseInput(PresenceBodySchema, request.body, reply)
    if (!body) return reply
    const { pageId } = request.params as { pageId: string }
    // Read access is enough to say where you are; a draft needs write, and
    // `publishSpreadsheetPresence` is what refuses one without it.
    const opened = await openPage(actorContext, pageId, 'read', reply)
    if (!opened) return reply
    try {
      const outcome = await publishSpreadsheetPresence(service, {
        organizationId: actorContext.tenant.organizationId,
        pageId,
        actor: await spreadsheetActorFor(deps, actorContext),
        frame: body.frame,
        canWrite: opened.canWrite,
        budget: service.presenceBudget,
      })
      return createApiResponse({ published: outcome.published })
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  app.delete('/api/knowledge-base/pages/:pageId/presence', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read'))) return reply
    const { pageId } = request.params as { pageId: string }
    const { clientId } = request.query as { clientId?: string }
    if (!clientId) return sendApiError(reply, 400, 'CLIENT_ID_REQUIRED', 'A clientId is required')
    if (!(await openPage(actorContext, pageId, 'read', reply))) return reply
    await publishSpreadsheetPresenceLeave(service, {
      organizationId: actorContext.tenant.organizationId,
      pageId,
      clientId,
    })
    return createApiResponse({ left: true })
  })

}
