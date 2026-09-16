import type { PrismaClient } from '@prisma/client'
import {
  completeSpreadsheetImport,
  createSpreadsheetService,
  enableXlsxParsing,
  type SpreadsheetModelCache,
} from '@nessie/knowledge'
import type { FileService, PgRealtimeTransport } from '@nessie/runtime'
import { z } from 'zod'

/**
 * `spreadsheet.import` — parsing an uploaded workbook, on the worker.
 *
 * It runs here and nowhere else because the parse can **kill its process**.
 * `fromXlsx` plus `evaluate()` on a foreign workbook writes one
 * `Unexpected type (empty) in Sheet!Cell` line per affected cell to fd 1 from
 * a Rust thread — 25 000 lines for a small fixture — and when that write fails
 * the engine panics inside the napi call. The panic crosses the napi boundary
 * as `fatal runtime error`, which `try`/`catch` never sees, and the process
 * aborts. Losing a worker costs a retried job; losing an API replica costs
 * every stream it was holding.
 *
 * The API therefore creates the page, stores the upload and enqueues this. The
 * page exists and is reachable the moment the upload is accepted (Rule zero);
 * this fills it, appends a `restore` batch so any open pane re-bootstraps, and
 * takes the import version.
 */

export const SPREADSHEET_IMPORT_TOPIC = 'spreadsheet.import'

export const SpreadsheetImportJobPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  pageId: z.string().uuid(),
  attachmentId: z.string().uuid(),
  filename: z.string().min(1).max(512),
  actorId: z.string().min(1),
  actorType: z.enum(['user', 'agent']),
})
export type SpreadsheetImportJobPayload = z.infer<typeof SpreadsheetImportJobPayloadSchema>

export type SpreadsheetImportDeps = {
  prisma: PrismaClient
  fileService: FileService
  cache: SpreadsheetModelCache
  realtime?: PgRealtimeTransport
  createPage: Parameters<typeof createSpreadsheetService>[0]['createPage']
  addFileVersion: Parameters<typeof createSpreadsheetService>[0]['addFileVersion']
}

export const executeSpreadsheetImportJob = async (
  deps: SpreadsheetImportDeps,
  payload: SpreadsheetImportJobPayload,
): Promise<{ versionId: string | null }> => {
  // The capability grant. Granted here rather than at worker start-up so it is
  // visible at the one call site that needs it, and so a reader of this file
  // meets the reason before the risk.
  enableXlsxParsing()

  const head = await deps.prisma.spreadsheetHead.findFirst({
    where: { pageId: payload.pageId, organizationId: payload.organizationId },
    select: { headSeq: true },
  })
  // The page was deleted, or a retry arrived after the import already landed.
  // `headSeq > 0` means a batch is on the journal, and the only batch a staged
  // page can have is this import's own.
  if (!head || Number(head.headSeq) > 0) return { versionId: null }

  const actor = await resolveActor(deps.prisma, payload)
  const service = createSpreadsheetService({
    prisma: deps.prisma,
    fileService: deps.fileService,
    cache: deps.cache,
    createPage: deps.createPage,
    addFileVersion: deps.addFileVersion,
    ...(deps.realtime
      ? {
          publish: async (event, input) => {
            await deps.realtime?.publishDocumentEphemeral(
              input.pageId,
              input.organizationId,
              event,
              input.data,
            )
          },
        }
      : {}),
  })

  const result = await completeSpreadsheetImport(service, {
    organizationId: payload.organizationId,
    pageId: payload.pageId,
    attachmentId: payload.attachmentId,
    filename: payload.filename,
    actor,
    attribution: {
      organizationId: payload.organizationId,
      actorType: payload.actorType,
      actorId: payload.actorId,
    } as Parameters<typeof completeSpreadsheetImport>[1]['attribution'],
  })
  return { versionId: result.versionId }
}

const resolveActor = async (
  prisma: PrismaClient,
  payload: SpreadsheetImportJobPayload,
): Promise<Parameters<typeof completeSpreadsheetImport>[1]['actor']> => {
  if (payload.actorType === 'agent') {
    const agent = await prisma.agent.findFirst({
      where: { id: payload.actorId, organizationId: payload.organizationId },
      select: { name: true },
    })
    return {
      type: 'agent',
      id: payload.actorId,
      displayName: agent?.name ?? 'Agent',
      agentId: payload.actorId,
    }
  }
  const user = await prisma.user.findUnique({
    where: { id: payload.actorId },
    select: { displayName: true },
  })
  return { type: 'user', id: payload.actorId, displayName: user?.displayName ?? 'Someone' }
}
