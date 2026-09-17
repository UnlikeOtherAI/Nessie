import type { SheetToolId } from '@nessie/knowledge'

import {
  runSheetCreateTool,
  runSheetExportTool,
  runSheetTool,
} from './pa-tools/spreadsheet-tools.js'
import type { AgenticToolResult, BuiltinToolRuntimeContext } from './tool-types.js'
import { wrapTool } from './tool-util.js'

/**
 * Spreadsheet tool dispatch, mirroring `kb-tool-dispatch.ts`.
 *
 * Deliberately thin. The knowledge-base dispatcher coerces every argument at
 * this seam because its handlers take typed inputs; these handlers take the
 * model's arguments as they arrived and hand them to the one shared
 * implementation in `@nessie/knowledge`, which coerces them once for both this
 * stack and the MCP mirror. Coercing here as well would give the two surfaces
 * two chances to disagree about what `{ values: "raw" }` means.
 *
 * Returns null when the tool is not a spreadsheet tool.
 */

const PAGE_TOOLS: ReadonlySet<string> = new Set<SheetToolId>([
  'sheet_describe',
  'sheet_read_range',
  'sheet_find',
  'sheet_replace',
  'sheet_write_range',
  'sheet_format_range',
  'sheet_structure',
  'sheet_filter',
  'sheet_tabs',
  'sheet_versions',
])

export const dispatchSheetTool = (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
  inputSummary: string,
): Promise<AgenticToolResult> | null => {
  if (PAGE_TOOLS.has(toolName)) {
    return wrapTool(inputSummary, () => runSheetTool(context, toolName as SheetToolId, args))
  }
  // The two that are not addressed by an existing page: one takes a space, the
  // other produces a file.
  if (toolName === 'sheet_create') {
    return wrapTool(inputSummary, () => runSheetCreateTool(context, args))
  }
  if (toolName === 'sheet_export') {
    return wrapTool(inputSummary, () => runSheetExportTool(context, args))
  }
  return null
}
