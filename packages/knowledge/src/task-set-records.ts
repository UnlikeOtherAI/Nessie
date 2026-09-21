import { createHash } from 'node:crypto'
import type { TaskSetSource } from '@nessie/schemas'

/** Parser budgets are separate from the model context budget. No record is truncated. */
export const TASK_SET_SOURCE_LIMITS = {
  bytes: 256 * 1024 * 1024,
  recordBytes: 1024 * 1024,
  columns: 512,
  depth: 64,
  pageSize: 200,
} as const

export class TaskSetSourceError extends Error {
  constructor(readonly code: string, message: string, readonly locator?: string) {
    super(message)
    this.name = 'TaskSetSourceError'
  }
}

export type TaskSetSourceRecord = { ordinal: number; value: unknown; locator: string; columns?: unknown[] }

export const taskSetHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

/** JSON object keys are ordered for identity; array order remains significant. */
export const taskSetCanonicalJson = (value: unknown, depth = 0): string => {
  if (depth > TASK_SET_SOURCE_LIMITS.depth) {
    throw new TaskSetSourceError('input_too_large', 'The selected input exceeds the nesting limit.')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => taskSetCanonicalJson(entry, depth + 1)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${taskSetCanonicalJson((value as Record<string, unknown>)[key], depth + 1)}`,
    ).join(',')}}`
  }
  throw new TaskSetSourceError('invalid_input', 'The selected input is not JSON data.')
}

/** Explicit field paths use JSON Pointer, or a literal top-level property name. */
export const taskSetField = (value: unknown, field: string | number): unknown => {
  const parts = typeof field === 'number'
    ? [String(field - 1)]
    : field.startsWith('/') ? field.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      : [field]
  let current = value
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      throw new TaskSetSourceError('invalid_mapping', `The selected field ${JSON.stringify(field)} is missing.`)
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export const taskSetMapInput = (value: unknown, source: TaskSetSource, columns?: unknown[]): unknown => {
  const fields = source.selection.fields
  const input = fields === undefined ? value : Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name,
      taskSetField(typeof field === 'number' && columns ? columns : value, field)]),
  )
  const json = taskSetCanonicalJson(input)
  if (Buffer.byteLength(json, 'utf8') > TASK_SET_SOURCE_LIMITS.recordBytes) {
    throw new TaskSetSourceError('input_too_large', 'The selected input exceeds the per-item byte limit.')
  }
  return input
}

export const taskSetTableRecord = (
  values: unknown[], headers: string[] | null, locator: string,
): unknown => {
  if (values.length > TASK_SET_SOURCE_LIMITS.columns) {
    throw new TaskSetSourceError('input_too_large', 'The record has too many columns.', locator)
  }
  if (!headers) return values
  if (values.length > headers.length) {
    throw new TaskSetSourceError('invalid_input', 'The record has more columns than its header.', locator)
  }
  return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? null]))
}

export const taskSetHeaders = (values: unknown[]): string[] => {
  const headers = values.map((value) => typeof value === 'string' ? value.trim() : '')
  if (!headers.length || headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new TaskSetSourceError('invalid_mapping', 'Headers must be nonempty, distinct text values.')
  }
  return headers
}
