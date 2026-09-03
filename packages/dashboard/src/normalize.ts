/**
 * HTTP response → JMESPath → declared columns → canonical envelope
 * (2026-08-13-live-data-dashboards plan §4.2).
 *
 * This is the only transformation language dashboards have, and the raw
 * response is discarded the moment this returns. Everything downstream — the
 * renderer, a snapshot, an agent's probe sample — sees only the envelope.
 *
 * Validation is deliberately strict rather than coercive. A row carrying an
 * undeclared key, a wrong type, a non-finite number, or an over-long string
 * fails the refresh; it is not repaired and not persisted "just in case". A
 * silently coerced value is a wrong number rendered confidently, which is the
 * failure mode the freshness footer exists to prevent — so it must not be
 * reachable in the first place.
 */

import { evaluateSandboxedJmespath } from '@nessie/team-admin'
import {
  DASHBOARD_DATASET_SCHEMA_VERSION,
  DASHBOARD_MAX_ROWS,
  DASHBOARD_MAX_STRING_CODE_POINTS,
  type DashboardCell,
  type DashboardDataset,
  type DashboardOutputColumn,
} from '@nessie/schemas'

export type DashboardNormalizeErrorCode =
  | 'SOURCE_TRANSFORM_FAILED'
  | 'SOURCE_TRANSFORM_NOT_A_LIST'
  | 'SOURCE_SCHEMA_MISMATCH'
  | 'SOURCE_TOO_MANY_ROWS'

export class DashboardNormalizeError extends Error {
  constructor(
    readonly code: DashboardNormalizeErrorCode,
    /**
     * Operator-facing. May name a column and a type, never a cell value — a
     * value is attacker-influenced and must not travel into a log or an error
     * that a lower-privileged viewer could see.
     */
    readonly detail?: string,
  ) {
    super(code)
    this.name = 'DashboardNormalizeError'
  }
}

/**
 * Control characters are stripped rather than rejected: they arrive routinely
 * in real APIs and carry no meaning in a chart label. Bidi overrides ARE
 * stripped too — they can reorder rendered text so a table reads differently
 * from the data underneath it, which is a spoofing surface, not a formatting
 * quirk. Tab and newline survive because a table cell may legitimately wrap.
 */
const CONTROL_AND_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu

const sanitizeString = (value: string): string => value.replace(CONTROL_AND_BIDI, '')

const isIsoLike = (value: string): boolean => !Number.isNaN(Date.parse(value))

const coerceCell = (
  raw: unknown,
  column: DashboardOutputColumn,
): DashboardCell => {
  if (raw === null || raw === undefined) {
    if (!column.nullable) {
      throw new DashboardNormalizeError(
        'SOURCE_SCHEMA_MISMATCH',
        `column "${column.key}" is not nullable but a row omitted it`,
      )
    }
    return null
  }

  switch (column.type) {
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new DashboardNormalizeError(
          'SOURCE_SCHEMA_MISMATCH',
          `column "${column.key}" declared number but received ${typeof raw}`,
        )
      }
      return raw
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        throw new DashboardNormalizeError(
          'SOURCE_SCHEMA_MISMATCH',
          `column "${column.key}" declared boolean but received ${typeof raw}`,
        )
      }
      return raw
    }
    case 'datetime': {
      if (typeof raw !== 'string' || !isIsoLike(raw)) {
        throw new DashboardNormalizeError(
          'SOURCE_SCHEMA_MISMATCH',
          `column "${column.key}" declared datetime but received an unparseable value`,
        )
      }
      return new Date(raw).toISOString()
    }
    case 'string': {
      if (typeof raw !== 'string') {
        throw new DashboardNormalizeError(
          'SOURCE_SCHEMA_MISMATCH',
          `column "${column.key}" declared string but received ${typeof raw}`,
        )
      }
      const cleaned = sanitizeString(raw)
      if ([...cleaned].length > DASHBOARD_MAX_STRING_CODE_POINTS) {
        throw new DashboardNormalizeError(
          'SOURCE_SCHEMA_MISMATCH',
          `column "${column.key}" exceeds ${DASHBOARD_MAX_STRING_CODE_POINTS} code points`,
        )
      }
      return cleaned
    }
  }
}

export type NormalizeInput = {
  document: unknown
  transform: string
  columns: DashboardOutputColumn[]
  fetchedAt: Date
}

export const normalizeDashboardDocument = async (
  input: NormalizeInput,
): Promise<DashboardDataset> => {
  const evaluated = await evaluateSandboxedJmespath(input.transform, input.document)
  if (!evaluated.ok) {
    // The evaluator's message describes the expression, not the document, so it
    // is safe to surface to the source's author.
    throw new DashboardNormalizeError('SOURCE_TRANSFORM_FAILED', evaluated.error)
  }

  const rows = evaluated.value
  if (!Array.isArray(rows)) {
    throw new DashboardNormalizeError(
      'SOURCE_TRANSFORM_NOT_A_LIST',
      'the transform must produce an array of records',
    )
  }
  if (rows.length > DASHBOARD_MAX_ROWS) {
    throw new DashboardNormalizeError(
      'SOURCE_TOO_MANY_ROWS',
      `${rows.length} rows exceeds the ${DASHBOARD_MAX_ROWS} cap`,
    )
  }

  const declared = new Set(input.columns.map((column) => column.key))
  const normalized = rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new DashboardNormalizeError(
        'SOURCE_SCHEMA_MISMATCH',
        `row ${index} is not an object`,
      )
    }
    const source = row as Record<string, unknown>

    for (const key of Object.keys(source)) {
      if (!declared.has(key)) {
        throw new DashboardNormalizeError(
          'SOURCE_SCHEMA_MISMATCH',
          `row ${index} carries undeclared field "${key}"`,
        )
      }
    }

    const output: Record<string, DashboardCell> = {}
    for (const column of input.columns) {
      output[column.key] = coerceCell(source[column.key], column)
    }
    return output
  })

  return {
    schemaVersion: DASHBOARD_DATASET_SCHEMA_VERSION,
    columns: input.columns,
    rows: normalized,
    fetchedAt: input.fetchedAt.toISOString(),
  }
}
