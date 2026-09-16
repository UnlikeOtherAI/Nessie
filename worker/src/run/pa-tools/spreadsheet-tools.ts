import { Readable } from 'node:stream'

import {
  SHEET_READ_TOOL_IDS,
  createSpreadsheetForTool,
  exportSpreadsheet,
  resolveRangeArgument,
  resolveSheetIndexByName,
  stageSpreadsheetImport,
  toSheetToolRefusal,
  runSheetPageTool,
  spreadsheetClientOpId,
  withSpreadsheetAtHead,
  type SheetToolId,
  type SpreadsheetEditActor,
} from '@nessie/knowledge'
import { enqueueQueueJob } from '@nessie/db'
import type { SpreadsheetSelection } from '@nessie/schemas'

import { fileServiceFor } from '../file-service.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { runSendMessageTool } from './message-delivery.js'
import {
  openSpreadsheetPage,
  openSpreadsheetSpace,
  spreadsheetActorFor,
  spreadsheetAttributionFor,
  spreadsheetServiceFor,
} from './spreadsheet-access.js'
import { createAgentPresencePublisher } from './spreadsheet-presence.js'
import { truncate } from './tool-output.js'

/**
 * The `sheet_*` builtins.
 *
 * Each handler does four things and delegates the fifth: it settles access,
 * resolves the agent's identity, announces where it is working, and hands the
 * call to the one shared implementation in `@nessie/knowledge`. The MCP mirror
 * runs the same implementation with a different actor — which is what makes
 * "the two surfaces are 1:1" a fact rather than an intention.
 *
 * The presence choreography is not garnish. There is no approval gate on these
 * writes, so the person watching the document is the review: they see the
 * agent's cursor arrive on a range, watch a small edit take shape cell by cell,
 * and — if it is wrong — have `sheet_versions restore` and the automatic
 * pre-write version waiting.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/agent-tools.md
 */

/** The topic the API route publishes too; the worker job is its only consumer. */
const SPREADSHEET_IMPORT_TOPIC = 'spreadsheet.import'

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const summarize = (args: Record<string, unknown>, extra: string): string =>
  truncate([str(args.pageId) ?? str(args.spaceId) ?? '', extra].filter(Boolean).join(' '), 200)

/**
 * Where the agent is about to be, in the grid's own terms.
 *
 * Best effort: a presence frame that could not be worked out (an unknown sheet,
 * a malformed range) must not stop the tool from answering with the real
 * refusal the caller needs.
 */
const presenceTarget = async (
  service: ReturnType<typeof spreadsheetServiceFor>,
  ref: { organizationId: string; pageId: string },
  args: Record<string, unknown>,
): Promise<{ sheet: number; selection: SpreadsheetSelection } | null> => {
  try {
    return await withSpreadsheetAtHead(service, ref, (workbook) => {
      const sheet = resolveSheetIndexByName(workbook.model, str(args.sheet) ?? null)
      return { sheet, selection: resolveRangeArgument(workbook.model, sheet, str(args.range) ?? null) }
    })
  } catch {
    return null
  }
}

/**
 * A run is one presence participant on a page's lane. Not `runId:pageId`:
 * `SpreadsheetPresenceFrameSchema` caps `clientId` at 64 characters, two uuids
 * and a colon are 73, and the frame was dropped without a word.
 */
export const agentPresenceClientId = (runId: string): string => `run:${runId}`

const rowsOf = (value: unknown): (string | number | boolean | null)[][] | undefined => {
  if (!Array.isArray(value)) return undefined
  return value.map((row) =>
    Array.isArray(row)
      ? row.map((cell) =>
        cell === null || cell === undefined
          ? null
          : typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean'
            ? cell
            : String(cell))
      : [])
}

/**
 * One handler for the ten page-addressed tools.
 *
 * Access is decided here, before anything reads a batch summary — and the
 * summary travels to the write door as a separate argument it never sees, so a
 * wrong or hostile one can cost a rebase and never a permission.
 */
export const runSheetTool = async (
  context: BuiltinToolRuntimeContext,
  toolId: SheetToolId,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const pageId = str(args.pageId) ?? ''
  const reads = SHEET_READ_TOOL_IDS.has(toolId)
  const opened = await openSpreadsheetPage(context, pageId, reads ? 'read' : 'write')
  const service = spreadsheetServiceFor(context)
  const actor = await spreadsheetActorFor(context)
  const ref = { organizationId: String(context.channel.organizationId), pageId }

  const presence = createAgentPresencePublisher(service, {
    ...ref,
    actor,
    clientId: agentPresenceClientId(context.run.id),
    canWrite: opened.canWrite,
  })

  const target = await presenceTarget(service, ref, args)
  if (target) {
    await presence.announce({
      ...target,
      ...(toolId === 'sheet_write_range' ? { rows: rowsOf(args.rows) } : {}),
    })
  }

  try {
    const result = await runSheetPageTool(
      service,
      {
        ...ref,
        actor,
        attribution: spreadsheetAttributionFor(context),
        // Idempotent on the tool call: a run resumed after a crash replays the
        // call and is answered with the batch that already landed.
        clientOpId: spreadsheetClientOpId(context.toolCallId ?? `${context.run.id}:${toolId}`),
      },
      toolId,
      args,
    )
    if (target) await presence.settle(target)
    return {
      inputSummary: summarize(args, toolId),
      outputPreview: JSON.stringify(result),
      toolName: toolId,
    }
  } catch (error) {
    const refusal = toSheetToolRefusal(error)
    if (!refusal) throw error
    // A refusal the model can act on — the sheet names it should have used, the
    // cell count and a split that fits, the engine's own words for what it
    // would not do — rather than a stack trace it will retry into a loop.
    if (target) await presence.settle(target)
    return {
      inputSummary: summarize(args, toolId),
      outputPreview: JSON.stringify(refusal),
      toolName: toolId,
    }
  }
}

// -------------------------------------------------------------------- create

export const runSheetCreateTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const spaceId = str(args.spaceId) ?? ''
  const title = str(args.title) ?? ''
  if (!title) throw new Error('title is required.')
  const space = await openSpreadsheetSpace(context, spaceId)
  const service = spreadsheetServiceFor(context)
  const actor = await spreadsheetActorFor(context)
  const who: SpreadsheetEditActor = {
    actor,
    attribution: spreadsheetAttributionFor(context),
    clientOpId: spreadsheetClientOpId(context.toolCallId ?? `${context.run.id}:sheet_create`),
  }
  const organizationId = String(context.channel.organizationId)
  const fromAttachmentId = str(args.fromAttachmentId)

  if (fromAttachmentId) return importSpreadsheet(context, {
    service,
    who,
    space,
    organizationId,
    title,
    attachmentId: fromAttachmentId,
    parentPageId: str(args.parentPageId) ?? null,
    taskId: str(args.taskId) ?? null,
  })

  const created = await createSpreadsheetForTool(service, who, {
    organizationId,
    spaceId,
    projectId: space.projectId,
    title,
    parentPageId: str(args.parentPageId) ?? null,
    taskId: str(args.taskId) ?? null,
    sheets: Array.isArray(args.sheets)
      ? args.sheets.map((entry) => {
        const sheet = asRecord(entry)
        return {
          ...(str(sheet.name) ? { name: str(sheet.name) as string } : {}),
          ...(rowsOf(sheet.rows) ? { rows: rowsOf(sheet.rows) as never } : {}),
        }
      })
      : [],
  })

  return {
    inputSummary: summarize(args, 'sheet_create'),
    outputPreview: JSON.stringify({
      pageId: created.page.id,
      title: created.page.title,
      spaceId,
      sheets: created.sheets,
      warnings: created.warnings,
    }),
    toolName: 'sheet_create',
  }
}

/**
 * Import runs as a job, never inline.
 *
 * `fromXlsx` plus `evaluate()` on a foreign workbook writes one diagnostic line
 * per affected cell to fd 1 from a Rust thread, and a failed write panics
 * inside the napi call and **aborts the process** — uncatchable
 * (`decisions.md`). Inside a tool call that would take the whole run, and every
 * other run the worker was holding, with it. The page exists and is openable
 * the moment this returns; the job fills it.
 */
const importSpreadsheet = async (
  context: BuiltinToolRuntimeContext,
  input: {
    service: ReturnType<typeof spreadsheetServiceFor>
    who: SpreadsheetEditActor
    space: { id: string; projectId: string }
    organizationId: string
    title: string
    attachmentId: string
    parentPageId: string | null
    taskId: string | null
  },
): Promise<ToolExecutionResult> => {
  const files = fileServiceFor(context.prisma)
  const opened = await files.openStream(input.attachmentId, input.organizationId)
  if (!opened) throw new Error('That attachment could not be read.')
  const chunks: Buffer[] = []
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Buffer))
  const filename = opened.attachment?.filename ?? 'upload.xlsx'

  const staged = await stageSpreadsheetImport(input.service, {
    organizationId: input.organizationId,
    spaceId: input.space.id,
    projectId: input.space.projectId,
    title: input.title,
    filename,
    bytes: Buffer.concat(chunks),
    parentPageId: input.parentPageId,
    taskId: input.taskId,
    actor: input.who.actor,
    attribution: input.who.attribution,
    createdBy: input.who.actor.id,
  })

  await enqueueQueueJob(context.prisma, {
    idempotencyKey: `sheet-import:${staged.page.id}:${staged.attachmentId}`,
    topic: SPREADSHEET_IMPORT_TOPIC,
    payload: {
      organizationId: input.organizationId,
      pageId: staged.page.id,
      attachmentId: staged.attachmentId,
      filename,
      actorId: input.who.actor.id,
      actorType: 'agent',
    },
  })

  return {
    inputSummary: `${staged.page.id} sheet_create import`,
    outputPreview: JSON.stringify({
      pageId: staged.page.id,
      title: staged.page.title,
      importing: true,
      message: 'The workbook is being read in the background; open it or describe it shortly.',
      warnings: staged.warnings,
    }),
    toolName: 'sheet_create',
  }
}

// -------------------------------------------------------------------- export

export const runSheetExportTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const pageId = str(args.pageId) ?? ''
  const opened = await openSpreadsheetPage(context, pageId, 'read')
  const service = spreadsheetServiceFor(context)
  const organizationId = String(context.channel.organizationId)
  const format = args.format === 'csv' ? 'csv' : 'xlsx'

  const sheetIndex = format === 'csv'
    ? await withSpreadsheetAtHead(service, { organizationId, pageId }, (workbook) =>
      resolveSheetIndexByName(workbook.model, str(args.sheet) ?? null))
    : undefined

  const file = await exportSpreadsheet(service, {
    organizationId,
    pageId,
    format,
    ...(sheetIndex === undefined ? {} : { sheet: sheetIndex }),
    ...(str(args.versionId) ? { versionId: str(args.versionId) as string } : {}),
  })

  const stored = await fileServiceFor(context.prisma).store({
    attribution: spreadsheetAttributionFor(context),
    body: Readable.from([file.bytes]),
    filename: file.filename,
    mime: file.mime,
    organizationId,
    scope: {
      projectId: opened.page.projectId,
      teamId: opened.page.teamId ?? null,
      spaceId: opened.page.spaceId,
    },
    uploaderId: null,
  })

  const postTo = asRecord(args.postTo)
  const channelId = str(postTo.channelId)
  const threadId = str(postTo.threadId)
  if (channelId || threadId) {
    // Delegated to the one message door rather than writing a second one: it
    // resolves the destination, refuses a single-member assistant DM and stamps
    // the run's disclosure basis on the post. A run with nobody to act as
    // cannot use it, and is told so with the attachment id in hand.
    try {
      const posted = await runSendMessageTool(context, {
        attachmentIds: [stored.attachment.id],
        content: `Export of “${opened.page.title}” as ${format.toUpperCase()}.`,
        ...(channelId ? { channelId } : {}),
        ...(threadId ? { threadId } : {}),
      })
      return {
        inputSummary: summarize(args, 'sheet_export'),
        outputPreview: JSON.stringify({
          attachmentId: stored.attachment.id,
          filename: file.filename,
          posted: true,
          detail: posted.outputPreview,
        }),
        toolName: 'sheet_export',
      }
    } catch (error) {
      return {
        inputSummary: summarize(args, 'sheet_export'),
        outputPreview: JSON.stringify({
          attachmentId: stored.attachment.id,
          filename: file.filename,
          posted: false,
          error: error instanceof Error ? error.message : String(error),
          hint: 'The file is stored; attach it to your own reply with this attachmentId.',
        }),
        toolName: 'sheet_export',
      }
    }
  }

  return {
    inputSummary: summarize(args, 'sheet_export'),
    outputPreview: JSON.stringify({
      attachmentId: stored.attachment.id,
      filename: file.filename,
      mime: file.mime,
      bytes: file.bytes.byteLength,
      downloadUrl: `/api/attachments/${stored.attachment.id}`,
    }),
    toolName: 'sheet_export',
  }
}
