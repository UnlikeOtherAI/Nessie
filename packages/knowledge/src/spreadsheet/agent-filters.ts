import {
  columnLabelToIndex,
  formatA1Range,
  type SpreadsheetFilterModel,
} from '@nessie/schemas'

import { invalidRequest } from './errors.js'
import {
  clearSpreadsheetFilter,
  getSpreadsheetFilters,
  reapplySpreadsheetFilter,
  setSpreadsheetFilter,
} from './filters.js'
import {
  resolveRangeArgument,
  resolveSheetIndexByName,
  withSpreadsheetAtHead,
  type SpreadsheetRef,
} from './agent-reads.js'
import type { SpreadsheetEditActor } from './agent-edits.js'
import type { SpreadsheetServiceDeps } from './deps.js'

/**
 * `sheet_filter`, in the vocabulary an agent can hold in its head.
 *
 * A person says "only the open and blocked rows, where the count is over ten",
 * and the persisted model wants column *indexes* and a discriminated union.
 * This is the translation, and it lives on the service side so the builtin and
 * the MCP mirror cannot disagree about what `{ 'C': { values: [...] } }` means.
 *
 * A filter set by an agent is the same persisted per-sheet model the pane
 * shows and the same engine row-hiding a person sees — the point of building a
 * filter model at all rather than letting each caller hide rows its own way.
 */

export type FilterColumnInput = {
  values?: readonly string[]
  blanks?: boolean
  op?: string
  value?: string | number
  value2?: string | number
  caseSensitive?: boolean
}

export type FilterToolInput = SpreadsheetRef & {
  sheet?: string | null
  action: 'get' | 'set' | 'clear' | 'reapply'
  range?: string | null
  columns?: Record<string, FilterColumnInput>
  sort?: { by: string; direction?: 'asc' | 'desc' }
}

const CONDITION_OPS = new Set([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
  'contains', 'notContains', 'startsWith', 'endsWith',
  'empty', 'notEmpty', 'between',
])

const columnKey = (label: string): string => {
  const trimmed = label.trim()
  // A column may arrive as a letter (`'C'`, what a person says) or as an index
  // (`'3'`, what the persisted model stores). Both are accepted; only one is
  // written.
  if (/^\d+$/.test(trimmed)) return trimmed
  return String(columnLabelToIndex(trimmed))
}

const criterionOf = (
  label: string,
  input: FilterColumnInput,
): SpreadsheetFilterModel['columns'][string] => {
  if (input.values) {
    return { kind: 'values', values: [...input.values], blanks: input.blanks === true }
  }
  if (!input.op) {
    throw invalidRequest(
      `Column ${label} needs either \`values\` or an \`op\``,
      { column: label },
    )
  }
  if (!CONDITION_OPS.has(input.op)) {
    throw invalidRequest(`Unknown filter operator ${JSON.stringify(input.op)}`, {
      column: label,
      operators: [...CONDITION_OPS],
    })
  }
  return {
    kind: 'condition',
    op: input.op as 'eq',
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.value2 === undefined ? {} : { value2: input.value2 }),
    ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
  }
}

export const runSpreadsheetFilterTool = async (
  deps: SpreadsheetServiceDeps,
  who: SpreadsheetEditActor,
  input: FilterToolInput,
): Promise<Record<string, unknown>> => {
  const plan = await withSpreadsheetAtHead(deps, input, (workbook) => {
    const sheet = resolveSheetIndexByName(workbook.model, input.sheet)
    return {
      sheet,
      name: workbook.model.sheets()[sheet]?.name ?? `Sheet${sheet + 1}`,
      range: resolveRangeArgument(workbook.model, sheet, input.range),
    }
  })

  if (input.action === 'get') {
    const filters = await getSpreadsheetFilters(deps, input)
    const model = filters[String(plan.sheet)] ?? null
    return {
      sheet: plan.name,
      filter: model,
      hiddenRows: model?.hiddenRows.length ?? 0,
    }
  }

  const who2 = { actor: who.actor, attribution: who.attribution }
  if (input.action === 'clear') {
    const result = await clearSpreadsheetFilter(deps, { ...input, sheet: plan.sheet, who: who2 })
    return {
      sheet: plan.name,
      cleared: true,
      shown: result.shown.length,
      seq: result.batch?.headSeq ?? null,
    }
  }
  if (input.action === 'reapply') {
    const result = await reapplySpreadsheetFilter(deps, { ...input, sheet: plan.sheet, who: who2 })
    return {
      sheet: plan.name,
      hidden: result.hidden.length,
      shown: result.shown.length,
      dropped: result.dropped,
      seq: result.batch?.headSeq ?? null,
    }
  }

  const columns: SpreadsheetFilterModel['columns'] = {}
  for (const [label, criterion] of Object.entries(input.columns ?? {})) {
    columns[columnKey(label)] = criterionOf(label, criterion)
  }
  const model: SpreadsheetFilterModel = {
    range: plan.range,
    columns,
    hiddenRows: [],
    appliedAtSeq: '0',
    ...(input.sort
      ? {
        sort: {
          column: columnLabelToIndex(input.sort.by.trim()),
          direction: input.sort.direction ?? 'asc',
        },
      }
      : {}),
  }
  const result = await setSpreadsheetFilter(deps, {
    ...input,
    sheet: plan.sheet,
    who: who2,
    model,
  })
  return {
    sheet: plan.name,
    range: formatA1Range(plan.range),
    hidden: result.hidden.length,
    shown: result.shown.length,
    dropped: result.dropped,
    seq: result.batch?.headSeq ?? null,
    filter: result.filters[String(plan.sheet)] ?? null,
  }
}
