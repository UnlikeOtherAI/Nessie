import { Readable } from 'node:stream'

import {
  canWriteSpace,
  createSpreadsheetForTool,
  exportSpreadsheet,
  resolveSheetIndexByName,
  toSheetToolRefusal,
  withSpreadsheetAtHead,
} from '@nessie/knowledge'
import { attributionFromActorContext } from '@nessie/runtime'
import { z } from 'zod'

import { emitAuditEvent } from '../../services/audit.js'
import { requireScope } from '../scopes.js'
import type { McpToolDefinition } from '../tool-context.js'
import {
  NOT_AVAILABLE,
  PAGE_UNREACHABLE,
  SPACE_UNREACHABLE,
  actorFor,
  openPage,
  pageTool,
  parentShareAllowsCreate,
  pageId,
  range,
  requestId,
  sheetName,
} from './spreadsheet-access.js'

/**
 * The twelve `nessie_sheet_*` definitions.
 *
 * Ten of them are one line of wiring each: `pageTool` in
 * `spreadsheet-access.ts` settles the scope, the policy and the space, and
 * hands the call to the same `@nessie/knowledge` operation the worker's builtin
 * calls. The two that are not addressed by an existing page — one takes a
 * space, the other produces a file — spell out their own access.
 */

export const spreadsheetTools = (): McpToolDefinition[] => [
  pageTool(
    'nessie_sheet_describe',
    'sheet_describe',
    'Describe a spreadsheet without reading any cells: its sheets, their used ranges '
    + 'and sizes, frozen panes, filters and version history. Call this first.',
    {},
  ),
  pageTool(
    'nessie_sheet_read_range',
    'sheet_read_range',
    'Read cells from one sheet. Defaults to the used range as displayed values. Over '
    + '10,000 cells is refused with the count and a split that fits. Rows a filter '
    + 'hides are left out unless you ask for them.',
    {
      sheet: sheetName,
      range,
      values: z.enum(['display', 'raw', 'formula']).optional(),
      format: z.enum(['rows', 'csv']).optional(),
      includeStyles: z.boolean().optional(),
      includeHidden: z.boolean().optional(),
    },
  ),
  pageTool(
    'nessie_sheet_find',
    'sheet_find',
    'Find cells whose displayed value — or formula text, with inFormulas — matches a '
    + 'query, across the workbook, one sheet or one range.',
    {
      query: z.string().min(1).max(1_000),
      scope: z.enum(['sheet', 'workbook', 'range']).optional(),
      sheet: sheetName,
      range,
      matchCase: z.boolean().optional(),
      wholeCell: z.boolean().optional(),
      regex: z.boolean().optional(),
      inFormulas: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  ),
  pageTool(
    'nessie_sheet_replace',
    'sheet_replace',
    'Replace matches of a query. By default it changes only the FIRST match and lists '
    + 'what else matched, so you can confirm before setting `all`.',
    {
      query: z.string().min(1).max(1_000),
      replacement: z.string().max(32_000),
      all: z.boolean().optional(),
      scope: z.enum(['sheet', 'workbook', 'range']).optional(),
      sheet: sheetName,
      range,
      matchCase: z.boolean().optional(),
      wholeCell: z.boolean().optional(),
      regex: z.boolean().optional(),
      inFormulas: z.boolean().optional(),
      requestId,
    },
  ),
  pageTool(
    'nessie_sheet_write_range',
    'sheet_write_range',
    'Write a block of cells in one call. `range` is the top-left anchor and `rows` is '
    + 'row-major; null clears a cell. Strings starting with "=" are formulas, evaluated '
    + 'by the same engine the browser runs.',
    {
      sheet: sheetName,
      range,
      rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
      mode: z.enum(['overwrite', 'insertRowsBelow']).optional(),
      parseValues: z.boolean().optional(),
      requestId,
    },
  ),
  pageTool(
    'nessie_sheet_format_range',
    'sheet_format_range',
    'Apply formatting to a range, or clear it. Number formats are Excel patterns; '
    + 'colours are "#RRGGBB".',
    {
      sheet: sheetName,
      range,
      style: z
        .object({
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          underline: z.boolean().optional(),
          strike: z.boolean().optional(),
          fontColor: z.string().optional(),
          background: z.string().optional(),
          fontSize: z.number().optional(),
          hAlign: z.enum(['left', 'center', 'right']).optional(),
          vAlign: z.enum(['top', 'center', 'bottom']).optional(),
          wrap: z.boolean().optional(),
          numberFormat: z.string().optional(),
          borders: z.enum(['none', 'all', 'outer']).optional(),
        })
        .optional(),
      clear: z.boolean().optional(),
      requestId,
    },
  ),
  pageTool(
    'nessie_sheet_structure',
    'sheet_structure',
    'Change a sheet\'s shape: insert, delete, move, hide, resize, freeze, sort or '
    + 'clear. Sorting keeps formatting with the row and keeps formulas meaning what '
    + 'they meant. A version is saved first before a delete, a clear or a sort.',
    {
      sheet: sheetName,
      action: z.enum([
        'insertRows', 'insertColumns', 'deleteRows', 'deleteColumns',
        'moveRows', 'moveColumns', 'hide', 'show', 'resize',
        'freeze', 'unfreeze', 'sort', 'clear',
      ]),
      range,
      count: z.number().int().optional(),
      delta: z.number().int().optional(),
      size: z.number().int().optional(),
      sort: z
        .object({ by: z.array(z.string()), hasHeader: z.boolean().optional() })
        .optional(),
      requestId,
    },
  ),
  pageTool(
    'nessie_sheet_filter',
    'sheet_filter',
    'Read, set, re-apply or clear the sheet\'s filter — the same one a person sees. '
    + 'Editing a cell never re-filters on its own; `reapply` is explicit.',
    {
      sheet: sheetName,
      action: z.enum(['get', 'set', 'clear', 'reapply']),
      range,
      columns: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      sort: z.object({ by: z.string(), direction: z.enum(['asc', 'desc']).optional() }).optional(),
      requestId,
    },
  ),
  pageTool(
    'nessie_sheet_tabs',
    'sheet_tabs',
    'Add, rename, delete, duplicate, move, hide or unhide a sheet. Deleting saves a '
    + 'version first and is refused for the last visible sheet.',
    {
      action: z.enum(['add', 'rename', 'delete', 'duplicate', 'move', 'hide', 'unhide']),
      name: sheetName,
      newName: sheetName,
      position: z.number().int().min(0).optional(),
      requestId,
    },
  ),
  pageTool(
    'nessie_sheet_versions',
    'sheet_versions',
    'Version history, newest first. `save` names a snapshot; `restore` puts one back '
    + 'after saving the current state first, so the restore is itself reversible. This '
    + 'is how you undo an edit and say which version you went back to.',
    {
      action: z.enum(['list', 'save', 'restore']),
      comment: z.string().max(500).optional(),
      versionId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      requestId,
    },
  ),
  {
    name: 'nessie_sheet_create',
    description:
      'Create a spreadsheet in a knowledge space, optionally seeded with rows. '
      + 'Importing a file is not available here — upload it in Nessie instead.',
    inputSchema: {
      spaceId: z.string().uuid(),
      title: z.string().min(1).max(512),
      parentPageId: z.string().uuid().optional(),
      taskId: z.string().uuid().optional(),
      sheets: z
        .array(z.object({
          name: z.string().max(200).optional(),
          rows: z
            .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
            .optional(),
        }))
        .optional(),
      requestId,
    },
    run: async (context, input) => {
      requireScope(context.scopes, 'documents_write')
      const access = context.knowledge
      const service = context.spreadsheet
      if (!access || !service) return NOT_AVAILABLE

      const decision = await context.checkPolicy(
        context.prisma,
        context.actorContext,
        'knowledge_page',
        'create',
      )
      if (!decision.allowed) return { error: `Knowledge base access denied: ${decision.reasonCode}` }

      const organizationId = context.actorContext.tenant.organizationId
      const spaceId = input.spaceId as string
      const space = await access.provider.getSpace(organizationId, spaceId)
      const viewer = await access.buildViewer(context.actorContext)
      if (!space) return SPACE_UNREACHABLE
      // The HTTP door's rule, mirrored: the space's write grant, or an `edit`
      // share on the page this one is being filed under. Creating at the space
      // root never consults shares, and a parent in another space would let a
      // grant in one authorize a create in another.
      if (
        !canWriteSpace(space, viewer)
        && !(await parentShareAllowsCreate(context, spaceId, input.parentPageId))
      ) {
        return SPACE_UNREACHABLE
      }

      const who = await actorFor(context, input)
      try {
        const created = await createSpreadsheetForTool(service, who, {
          organizationId,
          spaceId,
          // Inherited from the destination space; accepting one from the caller
          // would let a document claim a project its space is not in.
          projectId: space.projectId,
          title: input.title as string,
          parentPageId: (input.parentPageId as string | undefined) ?? null,
          taskId: (input.taskId as string | undefined) ?? null,
          sheets: (input.sheets ?? []) as never,
        })
        await emitAuditEvent(context.prisma, {
          action: 'kb.page.created',
          actorContext: context.actorContext,
          metadata: { spaceId, title: created.page.title, kind: 'spreadsheet', via: 'mcp_agent_credential' },
          outcome: 'success',
          resourceId: created.page.id,
          resourceType: 'knowledge_page',
        })
        return {
          pageId: created.page.id,
          title: created.page.title,
          spaceId,
          sheets: created.sheets,
        }
      } catch (error) {
        const refusal = toSheetToolRefusal(error)
        if (!refusal) throw error
        return refusal
      }
    },
  },
  {
    name: 'nessie_sheet_export',
    description:
      'Render a spreadsheet — live, or one stored version — as .xlsx or .csv and '
      + 'return an attachment id and a download URL.',
    inputSchema: {
      pageId,
      format: z.enum(['xlsx', 'csv']),
      sheet: sheetName,
      versionId: z.string().uuid().optional(),
    },
    run: async (context, input) => {
      requireScope(context.scopes, 'documents_read')
      const service = context.spreadsheet
      if (!service || !context.knowledge) return NOT_AVAILABLE
      const opened = await openPage(context, input.pageId as string, 'read')
      if ('error' in opened) return opened

      const organizationId = context.actorContext.tenant.organizationId
      const format = input.format === 'csv' ? 'csv' : 'xlsx'
      const page = await context.knowledge.provider.getPage(organizationId, opened.page.id)
      if (!page) return PAGE_UNREACHABLE

      try {
        const sheet = format === 'csv'
          ? await withSpreadsheetAtHead(service, { organizationId, pageId: page.id }, (workbook) =>
            resolveSheetIndexByName(workbook.model, (input.sheet as string | undefined) ?? null))
          : undefined
        const file = await exportSpreadsheet(service, {
          organizationId,
          pageId: page.id,
          format,
          ...(sheet === undefined ? {} : { sheet }),
          ...(input.versionId ? { versionId: input.versionId as string } : {}),
        })
        const stored = await service.fileService.store({
          attribution: attributionFromActorContext(context.actorContext),
          body: Readable.from([file.bytes]),
          filename: file.filename,
          mime: file.mime,
          organizationId,
          scope: { projectId: page.projectId, teamId: page.teamId ?? null, spaceId: page.spaceId },
          uploaderId: context.actorContext.actor.actorId,
        })
        return {
          attachmentId: stored.attachment.id,
          filename: file.filename,
          mime: file.mime,
          bytes: file.bytes.byteLength,
          downloadUrl: `/api/attachments/${stored.attachment.id}`,
        }
      } catch (error) {
        const refusal = toSheetToolRefusal(error)
        if (!refusal) throw error
        return refusal
      }
    },
  },
]
