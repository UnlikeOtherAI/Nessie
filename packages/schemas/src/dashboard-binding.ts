/**
 * Binding validation: every column a widget names must exist in its source's
 * declared output schema, with a type the widget can actually render.
 *
 * This is the second half of the boundary in `dashboards.ts`. The schema proves
 * a definition is *well-formed*; this proves it is *bindable* — so an agent
 * cannot invent a field, and cannot plot a string as a number and get a chart
 * of `NaN`. It runs at write time (a precise author-facing error) and again at
 * read time (the source's columns may have changed under a stored widget).
 *
 * Pure and dependency-free so the admin can run the same check while an author
 * is still typing, exactly as the workflow designer previews JMESPath with the
 * same evaluator the worker runs.
 */

import type {
  DashboardColumnType,
  DashboardOutputColumn,
  WidgetDefinition,
} from './dashboards.js'

export type BindingIssue = {
  path: string
  message: string
}

type ColumnIndex = Map<string, DashboardOutputColumn>

const indexColumns = (columns: DashboardOutputColumn[]): ColumnIndex =>
  new Map(columns.map((column) => [column.key, column]))

const requireColumn = (
  index: ColumnIndex,
  key: string,
  path: string,
  allowed: DashboardColumnType[],
  issues: BindingIssue[],
): void => {
  const column = index.get(key)
  if (!column) {
    issues.push({ path, message: `no column named "${key}" in the source's declared schema` })
    return
  }
  if (!allowed.includes(column.type)) {
    issues.push({
      path,
      message: `column "${key}" is ${column.type}; this slot accepts ${allowed.join(' or ')}`,
    })
  }
}

const NUMERIC: DashboardColumnType[] = ['number']
const TEMPORAL: DashboardColumnType[] = ['datetime', 'string', 'number']
const CATEGORICAL: DashboardColumnType[] = ['string', 'boolean', 'number']
const ANY: DashboardColumnType[] = ['string', 'number', 'boolean', 'datetime']

/**
 * Returns every problem rather than the first, so an author fixes one widget in
 * one round trip instead of playing whack-a-mole through repeated tool calls.
 */
export const validateWidgetBinding = (
  definition: WidgetDefinition,
  columns: DashboardOutputColumn[],
): BindingIssue[] => {
  const issues: BindingIssue[] = []
  const index = indexColumns(columns)

  switch (definition.kind) {
    case 'stat': {
      const { binding } = definition
      requireColumn(index, binding.value, 'binding.value', NUMERIC, issues)
      if (binding.compareTo) {
        requireColumn(index, binding.compareTo, 'binding.compareTo', NUMERIC, issues)
      }
      if (binding.spark) {
        requireColumn(index, binding.spark, 'binding.spark', NUMERIC, issues)
      }
      break
    }
    case 'timeseries': {
      const { binding } = definition
      requireColumn(index, binding.x, 'binding.x', TEMPORAL, issues)
      binding.series.forEach((series, position) => {
        requireColumn(index, series.key, `binding.series[${position}].key`, NUMERIC, issues)
      })
      break
    }
    case 'bar': {
      const { binding } = definition
      requireColumn(index, binding.category, 'binding.category', CATEGORICAL, issues)
      binding.series.forEach((series, position) => {
        requireColumn(index, series.key, `binding.series[${position}].key`, NUMERIC, issues)
      })
      break
    }
    case 'donut': {
      const { binding } = definition
      requireColumn(index, binding.category, 'binding.category', CATEGORICAL, issues)
      requireColumn(index, binding.value, 'binding.value', NUMERIC, issues)
      break
    }
    case 'gauge': {
      const { binding } = definition
      requireColumn(index, binding.value, 'binding.value', NUMERIC, issues)
      requireColumn(index, binding.target, 'binding.target', NUMERIC, issues)
      break
    }
    case 'scatter': {
      const { binding } = definition
      requireColumn(index, binding.x, 'binding.x', NUMERIC, issues)
      requireColumn(index, binding.y, 'binding.y', NUMERIC, issues)
      if (binding.label) {
        requireColumn(index, binding.label, 'binding.label', CATEGORICAL, issues)
      }
      break
    }
    case 'table': {
      const { binding } = definition
      binding.columns.forEach((column, position) => {
        requireColumn(index, column.key, `binding.columns[${position}].key`, ANY, issues)
      })
      if (binding.sort) {
        const bound = new Set(binding.columns.map((column) => column.key))
        if (!bound.has(binding.sort.key)) {
          issues.push({
            path: 'binding.sort.key',
            message: `cannot sort by "${binding.sort.key}" because the table does not display it`,
          })
        }
      }
      break
    }
    case 'status': {
      const { binding } = definition
      requireColumn(index, binding.state, 'binding.state', CATEGORICAL, issues)
      if (binding.since) {
        requireColumn(index, binding.since, 'binding.since', TEMPORAL, issues)
      }
      break
    }
  }

  return issues
}

export const assertWidgetBinding = (
  definition: WidgetDefinition,
  columns: DashboardOutputColumn[],
): void => {
  const issues = validateWidgetBinding(definition, columns)
  if (issues.length > 0) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    throw new Error(`widget binding does not match the source schema — ${detail}`)
  }
}
