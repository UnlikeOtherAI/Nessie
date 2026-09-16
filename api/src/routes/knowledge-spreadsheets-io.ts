import type { FastifyInstance } from 'fastify'
import {
  SPREADSHEET_IMPORT_LIMITS,
  exportSpreadsheet,
  stageFileConversion,
  stageSpreadsheetImport,
  type XlsxImportWarning,
} from '@nessie/knowledge'
import { enqueueQueueJob } from '@nessie/db'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { readStreamCapped } from '../lib/markdown.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  attachPageEnvelope,
  requireKnowledgePolicy,
  requestIds,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'
import {
  sendSpreadsheetError,
  spreadsheetActorFor,
  spreadsheetAttribution,
  type SpreadsheetRouteContext,
} from './knowledge-spreadsheets-context.js'

/**
 * Import, convert and export.
 *
 * **The API never parses a workbook.** `fromXlsx` plus `evaluate()` on a
 * foreign file writes one diagnostic line per affected cell to fd 1 from a
 * Rust thread — tens of thousands for a small workbook — and a failed write
 * panics inside the napi call and kills the process, which `try`/`catch`
 * cannot see. On an API replica that is every open stream in the building. So
 * the route does everything that is safe without the engine (sniff the format,
 * apply the caps, derive the loss list, create the page and store the upload)
 * and enqueues the parse for the worker, which answers `202`.
 *
 * `@nessie/knowledge`'s engine module makes that a capability rather than a
 * convention: parsing throws in a process that has not been granted it, so a
 * later route cannot reintroduce the hazard by calling the wrong function.
 *
 * Export is different and stays here: `saveToXlsx` renders a model this
 * process built, emits no diagnostics, and its one abort mode (a missing
 * parent directory) is closed by the temp-directory helper.
 */

/**
 * The worker topic the parse rides. Declared here beside its only publisher;
 * `worker/src/control/spreadsheet-import.ts` is its only consumer.
 */
export const SPREADSHEET_IMPORT_TOPIC = 'spreadsheet.import'

const ImportQuerySchema = z.object({
  title: z.string().min(1).max(512).optional(),
  parentPageId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
})

const ConvertBodySchema = z.object({
  title: z.string().min(1).max(512).optional(),
})

const ExportQuerySchema = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  sheet: z.coerce.number().int().min(0).optional(),
  versionId: z.string().uuid().optional(),
})

export const registerKnowledgeSpreadsheetIoRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
  context: SpreadsheetRouteContext,
): void => {
  const { prisma, requireActorContext } = deps
  const { service, access } = context
  const { buildViewer, accessSpace, accessPageSpace } = access

  /**
   * Hand the parse to the worker. Enqueued *after* the page and the upload
   * committed, so a job can never name a page that does not exist; a failed
   * enqueue leaves an empty spreadsheet and a stored upload, which the retry
   * (or a second convert) finishes — never a half-parsed workbook.
   */
  const enqueueImport = async (
    actorContext: Parameters<typeof spreadsheetActorFor>[1],
    staged: { page: { id: string }; attachmentId: string },
    filename: string,
  ): Promise<void> => {
    await enqueueQueueJob(prisma, {
      idempotencyKey: `sheet-import:${staged.page.id}:${staged.attachmentId}`,
      topic: SPREADSHEET_IMPORT_TOPIC,
      payload: {
        organizationId: actorContext.tenant.organizationId,
        pageId: staged.page.id,
        attachmentId: staged.attachmentId,
        filename,
        actorId: actorContext.actor.actorId,
        actorType: actorContext.actor.actorType === 'agent' ? 'agent' : 'user',
      },
    })
  }

  app.post('/api/knowledge-base/spaces/:spaceId/spreadsheets/import', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(ImportQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const viewer = await buildViewer(actorContext)
    const space = await accessSpace(actorContext, spaceId, viewer, 'write', reply)
    if (!space) return reply

    const file = await request.file()
    if (!file) return sendApiError(reply, 400, 'NO_FILE', 'No file part found in the upload')
    const bytes = await readStreamCapped(file.file, SPREADSHEET_IMPORT_LIMITS.maxImportBytes)
    if (!bytes) {
      return sendApiError(reply, 413, 'FILE_TOO_LARGE', 'That workbook exceeds the import limit')
    }
    const filename = file.filename || 'workbook.xlsx'

    try {
      const staged = await stageSpreadsheetImport(service, {
        organizationId: actorContext.tenant.organizationId,
        spaceId,
        projectId: space.projectId,
        title: query.title ?? filename.replace(/\.[^.]+$/, ''),
        filename,
        bytes,
        parentPageId: query.parentPageId ?? null,
        taskId: query.taskId ?? null,
        actor: await spreadsheetActorFor(deps, actorContext),
        attribution: spreadsheetAttribution(actorContext),
        createdBy: actorContext.actor.actorId,
      })
      await enqueueImport(actorContext, staged, filename)
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.spreadsheet.imported',
        resourceType: 'knowledge_page',
        resourceId: staged.page.id,
        outcome: 'success',
        metadata: {
          spaceId,
          filename,
          attachmentId: staged.attachmentId,
          warnings: staged.warnings.map((warning: XlsxImportWarning) => warning.code),
        },
        ...requestIds(request),
      })
      // 202: the page exists and is reachable now, and the workbook lands when
      // the worker has parsed it. The pane watches the live lane for the
      // `restore` batch that says it arrived.
      return reply.code(202).send(
        createApiResponse({
          page: attachPageEnvelope(staged.page, decision),
          status: 'importing',
          warnings: staged.warnings,
        }),
      )
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  app.post('/api/knowledge-base/pages/:pageId/convert-to-spreadsheet', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(ConvertBodySchema, request.body ?? {}, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const source = await access.provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!source) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    // Converting creates a page in this space and reads the original's bytes,
    // so it takes the space's write grant, not just read.
    if (!(await accessPageSpace(actorContext, source, viewer, 'write', reply))) return reply

    try {
      const staged = await stageFileConversion(service, {
        organizationId: actorContext.tenant.organizationId,
        pageId,
        actor: await spreadsheetActorFor(deps, actorContext),
        attribution: spreadsheetAttribution(actorContext),
        ...(body.title ? { title: body.title } : {}),
      })
      await enqueueImport(actorContext, staged, staged.filename)
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.spreadsheet.imported',
        resourceType: 'knowledge_page',
        resourceId: staged.page.id,
        outcome: 'success',
        metadata: {
          convertedFromPageId: pageId,
          attachmentId: staged.attachmentId,
          warnings: staged.warnings.map((warning: XlsxImportWarning) => warning.code),
        },
        ...requestIds(request),
      })
      return reply.code(202).send(
        createApiResponse({
          page: attachPageEnvelope(staged.page, decision),
          status: 'importing',
          warnings: staged.warnings,
        }),
      )
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })

  app.get('/api/knowledge-base/pages/:pageId/spreadsheet/export', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read'))) return reply
    const query = parseInput(ExportQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const { pageId } = request.params as { pageId: string }
    const page = await access.provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!page || page.kind !== 'spreadsheet') {
      return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Spreadsheet not found')
    }
    const viewer = await buildViewer(actorContext)
    // `accessPageSpace` also enforces every-version-readable, which is what
    // makes exporting a *version* safe without a second disclosure check.
    if (!(await accessPageSpace(actorContext, page, viewer, 'read', reply))) return reply

    try {
      const rendition = await exportSpreadsheet(service, {
        organizationId: actorContext.tenant.organizationId,
        pageId,
        format: query.format ?? 'xlsx',
        ...(query.sheet === undefined ? {} : { sheet: query.sheet }),
        ...(query.versionId ? { versionId: query.versionId } : {}),
      })
      return reply
        .header('Content-Type', rendition.mime)
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(rendition.filename)}`,
        )
        .send(rendition.bytes)
    } catch (error) {
      return sendSpreadsheetError(reply, error)
    }
  })
}
