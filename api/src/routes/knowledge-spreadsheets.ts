import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  applySpreadsheetBatch,
  bootstrapSpreadsheet,
  clearSpreadsheetFilter,
  createSpreadsheetPage,
  createSpreadsheetSnapshot,
  findInSpreadsheet,
  getSpreadsheetFilters,
  listSpreadsheetBatches,
  publishSpreadsheetPresence,
  publishSpreadsheetPresenceLeave,
  readSpreadsheetRange,
  reapplySpreadsheetFilter,
  replaceInSpreadsheet,
  restructureSpreadsheet,
  setSpreadsheetFilter,
  type KnowledgePageRecord,
} from '@nessie/knowledge'
import {
  SPREADSHEET_LIMITS,
  SpreadsheetOpBatchInputSchema,
  parseA1Range,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  attachPageEnvelope,
  requireKnowledgePolicy,
  requireProjectId,
  requestIds,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'
import {
  createSpreadsheetRouteContext,
  sendSpreadsheetError,
  spreadsheetActorFor,
  spreadsheetAttribution,
  type SpreadsheetRouteContext,
} from './knowledge-spreadsheets-context.js'
import { registerKnowledgeSpreadsheetIoRoutes } from './knowledge-spreadsheets-io.js'
import { registerKnowledgeSpreadsheetLiveRoute } from './knowledge-spreadsheet-live.js'

/**
 * The spreadsheet REST surface.
 *
 * Permissions are the kind's siblings' exactly: create is `canWriteSpace` +
 * `page:create`; bootstrap, catch-up, read, find and export are
 * `accessPageSpace(read)` — which also enforces every-version-readable;
 * batches, structure, filters, replace, presence drafts, save-version and
 * restore are `accessPageSpace(write)` + `page:edit`.
 *
 * **The batch summary is never read on this path.** Access is decided from the
 * actor context and the page's space before `applySpreadsheetBatch` is called,
 * and the summary travels to the write door as a separate argument.
 */

const CreateSpreadsheetBodySchema = z.object({
  title: z.string().min(1).max(512),
  parentPageId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
})

const OpsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(SPREADSHEET_LIMITS.opsCatchUpPageSize).optional(),
})

const RangeQuerySchema = z.object({
  sheet: z.coerce.number().int().min(0).default(0),
  a1: z.string().min(1).max(64),
  values: z.enum(['formatted', 'both']).default('formatted'),
})

const FindQuerySchema = z.object({
  q: z.string().min(1).max(1_000),
  sheet: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  matchCase: z.enum(['true', 'false']).optional(),
  wholeCell: z.enum(['true', 'false']).optional(),
  inFormulas: z.enum(['true', 'false']).optional(),
})

const ReplaceBodySchema = z.object({
  query: z.string().min(1).max(1_000),
  replacement: z.string().max(SPREADSHEET_LIMITS.maxCellTextChars),
  clientOpId: z.string().uuid().optional(),
  sheet: z.number().int().min(0).optional(),
  matchCase: z.boolean().optional(),
  wholeCell: z.boolean().optional(),
  regex: z.boolean().optional(),
  inFormulas: z.boolean().optional(),
})

const NamedVersionBodySchema = z.object({
  changeComment: z.string().min(1).max(500),
})

const PresenceBodySchema = z.object({
  frame: z.unknown(),
})

const RestructureBodySchema = z.object({
  clientOpId: z.string().uuid().optional(),
  action: z.unknown(),
})

export const registerKnowledgeSpreadsheetRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
  /**
   * Built once per process by the composition root — the model cache and the
   * presence budget are its closure state, and the io, live and restore paths
   * all have to share exactly this instance.
   */
  spreadsheetContext?: SpreadsheetRouteContext,
): void => {
  const context: SpreadsheetRouteContext = spreadsheetContext ?? createSpreadsheetRouteContext(deps)
  const { service, access } = context
  const { prisma, requireActorContext } = deps
  const { buildViewer, accessSpace, accessPageSpace } = access

  /**
   * Load a spreadsheet page and enforce the space's read or write grant.
   * Returns null having already answered the request when the caller may not
   * proceed — including for a page that is not a spreadsheet, which is a 404
   * rather than a 400 so the routes reveal nothing about a page the caller
   * cannot see.
   */
  const openPage = async (
    actorContext: AuthorizedActionContext,
    pageId: string,
    mode: 'read' | 'write',
    reply: FastifyReply,
  ): Promise<{ page: KnowledgePageRecord; canWrite: boolean } | null> => {
    const page = await access.provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!page || page.kind !== 'spreadsheet') {
      sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Spreadsheet not found')
      return null
    }
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, mode, reply))) return null
    if (mode === 'write') return { page, canWrite: true }
    // A reader is told whether they may write, so the pane can show a
    // read-only state rather than discovering it on the first edit.
    const canWrite = await accessPageSpace(
      actorContext,
      page,
      viewer,
      'write',
      // A refusal here is an answer to the *question*, not to the request.
      { code: () => ({ send: () => undefined }) } as unknown as FastifyReply,
    )
    return { page, canWrite }
  }

  // ─── Create ───────────────────────────────────────────────────────────────
  app.post('/api/knowledge-base/spaces/:spaceId/spreadsheets', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateSpreadsheetBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const viewer = await buildViewer(actorContext)
    const space = await accessSpace(actorContext, spaceId, viewer, 'write', reply)
    if (!space) return reply
    const projectId = requireProjectId(actorContext, body.projectId ?? space.projectId, reply)
    if (!projectId) return reply

    try {
      const page = await createSpreadsheetPage(service, {
        organizationId: actorContext.tenant.organizationId,
        spaceId,
        projectId: space.projectId,
        title: body.title,
        parentPageId: body.parentPageId ?? null,
        taskId: body.taskId ?? null,
        authorId: actorContext.actor.actorId,
        authorType: actorContext.actor.actorType === 'agent' ? 'agent' : 'user',
        createdBy: actorContext.actor.actorId,
      })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.page.created',
        resourceType: 'knowledge_page',
        resourceId: page.id,
        outcome: 'success',
        metadata: { spaceId, title: page.title, kind: 'spreadsheet' },
        ...requestIds(request),
      })
      return reply.code(201).send(createApiResponse(attachPageEnvelope(page, decision)))
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  // ─── Bootstrap and catch-up ───────────────────────────────────────────────
  app.get('/api/knowledge-base/pages/:pageId/spreadsheet', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read'))) return reply
    const { pageId } = request.params as { pageId: string }
    const opened = await openPage(actorContext, pageId, 'read', reply)
    if (!opened) return reply
    try {
      return createApiResponse(
        await bootstrapSpreadsheet(service, {
          organizationId: actorContext.tenant.organizationId,
          pageId,
          viewer: {
            canWrite: opened.canWrite,
            actor: await spreadsheetActorFor(deps, actorContext),
          },
        }),
      )
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  app.get('/api/knowledge-base/pages/:pageId/spreadsheet/ops', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read'))) return reply
    const query = parseInput(OpsQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const { pageId } = request.params as { pageId: string }
    if (!(await openPage(actorContext, pageId, 'read', reply))) return reply
    try {
      return createApiResponse(
        await listSpreadsheetBatches(service, {
          organizationId: actorContext.tenant.organizationId,
          pageId,
          afterSeq: query.afterSeq ?? 0,
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        }),
      )
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  // ─── The write door ───────────────────────────────────────────────────────
  app.post('/api/knowledge-base/pages/:pageId/spreadsheet/ops', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit'))) return reply
    const body = parseInput(SpreadsheetOpBatchInputSchema, request.body, reply)
    if (!body) return reply
    const { pageId } = request.params as { pageId: string }
    // Access is settled here, from the actor context and the page's space.
    // `body.summary` has not been read and never will be on this path.
    if (!(await openPage(actorContext, pageId, 'write', reply))) return reply

    try {
      const result = await applySpreadsheetBatch(
        service,
        {
          organizationId: actorContext.tenant.organizationId,
          pageId,
          clientOpId: body.clientOpId,
          actor: await spreadsheetActorFor(deps, actorContext),
          attribution: spreadsheetAttribution(actorContext),
          source: {
            kind: 'client',
            diffs: Buffer.from(body.diffs, 'base64'),
            baseSeq: body.baseSeq,
          },
        },
        body.summary,
      )
      return createApiResponse(result)
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  app.post('/api/knowledge-base/pages/:pageId/spreadsheet/structure', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit'))) return reply
    const body = parseInput(RestructureBodySchema, request.body, reply)
    if (!body) return reply
    const { pageId } = request.params as { pageId: string }
    if (!(await openPage(actorContext, pageId, 'write', reply))) return reply
    try {
      return createApiResponse(
        await restructureSpreadsheet(service, {
          organizationId: actorContext.tenant.organizationId,
          pageId,
          actor: await spreadsheetActorFor(deps, actorContext),
          attribution: spreadsheetAttribution(actorContext),
          ...(body.clientOpId ? { clientOpId: body.clientOpId } : {}),
          action: body.action as Parameters<typeof restructureSpreadsheet>[1]['action'],
        }),
      )
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  app.post('/api/knowledge-base/pages/:pageId/spreadsheet/replace', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit'))) return reply
    const body = parseInput(ReplaceBodySchema, request.body, reply)
    if (!body) return reply
    const { pageId } = request.params as { pageId: string }
    if (!(await openPage(actorContext, pageId, 'write', reply))) return reply
    try {
      return createApiResponse(
        await replaceInSpreadsheet(service, {
          organizationId: actorContext.tenant.organizationId,
          pageId,
          actor: await spreadsheetActorFor(deps, actorContext),
          attribution: spreadsheetAttribution(actorContext),
          ...(body.clientOpId ? { clientOpId: body.clientOpId } : {}),
          options: {
            query: body.query,
            replacement: body.replacement,
            ...(body.sheet === undefined
              ? {}
              : { scope: { kind: 'sheet' as const, sheet: body.sheet } }),
            ...(body.matchCase === undefined ? {} : { matchCase: body.matchCase }),
            ...(body.wholeCell === undefined ? {} : { wholeCell: body.wholeCell }),
            ...(body.regex === undefined ? {} : { regex: body.regex }),
            ...(body.inFormulas === undefined ? {} : { inFormulas: body.inFormulas }),
          },
        }),
      )
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  // ─── Reads ────────────────────────────────────────────────────────────────
  app.get('/api/knowledge-base/pages/:pageId/spreadsheet/range', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read'))) return reply
    const query = parseInput(RangeQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const { pageId } = request.params as { pageId: string }
    if (!(await openPage(actorContext, pageId, 'read', reply))) return reply
    try {
      return createApiResponse(
        await readSpreadsheetRange(service, {
          organizationId: actorContext.tenant.organizationId,
          pageId,
          sheet: query.sheet ?? 0,
          range: parseA1Range(query.a1),
          withContent: query.values === 'both',
        }),
      )
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  app.get('/api/knowledge-base/pages/:pageId/spreadsheet/find', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read'))) return reply
    const query = parseInput(FindQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const { pageId } = request.params as { pageId: string }
    if (!(await openPage(actorContext, pageId, 'read', reply))) return reply
    try {
      return createApiResponse(
        await findInSpreadsheet(service, {
          organizationId: actorContext.tenant.organizationId,
          pageId,
          query: query.q,
          ...(query.sheet === undefined
            ? {}
            : { scope: { kind: 'sheet' as const, sheet: query.sheet } }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          matchCase: query.matchCase === 'true',
          wholeCell: query.wholeCell === 'true',
          inFormulas: query.inFormulas === 'true',
        }),
      )
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

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

  const filterWriter = (
    run: (
      input: {
        organizationId: string
        pageId: string
        sheet: number
        who: { actor: Awaited<ReturnType<typeof spreadsheetActorFor>>; attribution: ReturnType<typeof spreadsheetAttribution> }
      },
      body: unknown,
    ) => Promise<unknown>,
  ) =>
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

  registerKnowledgeSpreadsheetIoRoutes(app, deps, context)
  registerKnowledgeSpreadsheetLiveRoute(app, deps, context)
}
