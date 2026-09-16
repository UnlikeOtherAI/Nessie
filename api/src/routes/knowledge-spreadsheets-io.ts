import type { FastifyInstance } from 'fastify'
import {
  SPREADSHEET_IMPORT_LIMITS,
  convertFileToSpreadsheet,
  exportSpreadsheet,
  importSpreadsheet,
} from '@nessie/knowledge'
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
 * The caps live in `@nessie/knowledge` rather than here, because the engine
 * has none of its own and a route is the wrong place for a number that three
 * callers must agree on. The upload is read into memory under the compressed
 * cap first; the *uncompressed* cap is what actually bounds the parse, and it
 * is checked from the zip's central directory before the engine sees anything.
 */

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
      const result = await importSpreadsheet(service, {
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
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.spreadsheet.imported',
        resourceType: 'knowledge_page',
        resourceId: result.page.id,
        outcome: 'success',
        metadata: {
          spaceId,
          filename,
          versionId: result.versionId,
          warnings: result.warnings.map((warning) => warning.code),
        },
        ...requestIds(request),
      })
      return reply.code(201).send(
        createApiResponse({
          page: attachPageEnvelope(result.page, decision),
          versionId: result.versionId,
          warnings: result.warnings,
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
      const result = await convertFileToSpreadsheet(service, {
        organizationId: actorContext.tenant.organizationId,
        pageId,
        actor: await spreadsheetActorFor(deps, actorContext),
        attribution: spreadsheetAttribution(actorContext),
        ...(body.title ? { title: body.title } : {}),
      })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.spreadsheet.imported',
        resourceType: 'knowledge_page',
        resourceId: result.page.id,
        outcome: 'success',
        metadata: {
          convertedFromPageId: pageId,
          versionId: result.versionId,
          warnings: result.warnings.map((warning) => warning.code),
        },
        ...requestIds(request),
      })
      return reply.code(201).send(
        createApiResponse({
          page: attachPageEnvelope(result.page, decision),
          versionId: result.versionId,
          warnings: result.warnings,
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
