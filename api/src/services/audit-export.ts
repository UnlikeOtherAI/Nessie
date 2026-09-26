import type { Prisma, PrismaClient } from '@prisma/client'

import {
  buildAuditLogWhere,
  toAuditLogRecord,
  type AuditLogFilters,
  type AuditLogRecord,
} from './audit.js'

/**
 * The audit trail as a file (`GET /api/audit-log/export`): every entry the same
 * filters would list, newest first — the order Admin › Security shows — as
 * CSV, streamed a page at a time so a long trail never sits in memory whole.
 *
 * The columns are the entry's own fields and nothing resolved beside them: an
 * export is for joining against other records, so it carries exact ids, and
 * the names the screen shows are the screen's.
 */

const EXPORT_PAGE_SIZE = 500

type Column = readonly [heading: string, value: (entry: AuditLogRecord) => unknown]

export const AUDIT_EXPORT_COLUMNS: readonly Column[] = [
  ['created_at', (entry) => entry.createdAt],
  ['actor_type', (entry) => entry.actorType],
  ['actor_id', (entry) => entry.actorId],
  ['action', (entry) => entry.action],
  ['outcome', (entry) => entry.outcome],
  ['reason', (entry) => entry.reason],
  ['resource_type', (entry) => entry.resourceType],
  ['resource_id', (entry) => entry.resourceId],
  ['team_id', (entry) => entry.teamId],
  ['project_id', (entry) => entry.projectId],
  ['channel_id', (entry) => entry.channelId],
  ['request_id', (entry) => entry.requestId],
  ['ip_address', (entry) => entry.ipAddress],
  ['user_agent', (entry) => entry.userAgent],
  ['metadata', (entry) => entry.metadata],
  ['entry_id', (entry) => entry.id],
]

// A cell a spreadsheet would evaluate as a formula. The trail holds text other
// people chose — a channel name, a rejection reason — and an export is opened
// in exactly the programs that run `=HYPERLINK(…)`, so such a cell is written
// as text by a leading apostrophe (OWASP's CSV-injection guidance).
const FORMULA_START = /^[=+\-@\t\r]/

/** One RFC 4180 cell: quoted when it holds a comma, quote or line break. */
export const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const inert = FORMULA_START.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(inert) ? `"${inert.replace(/"/g, '""')}"` : inert
}

const csvRow = (cells: readonly unknown[]): string => `${cells.map(csvCell).join(',')}\r\n`

/**
 * Keyset pages over `(createdAt, id)` descending — the same order and the same
 * tie-break the list pages by, because `createdAt` alone is not unique.
 */
export async function* streamAuditLogCsv(
  prisma: PrismaClient,
  filters: AuditLogFilters,
): AsyncGenerator<string> {
  yield csvRow(AUDIT_EXPORT_COLUMNS.map(([heading]) => heading))
  const where = buildAuditLogWhere(filters)
  let after: { createdAt: Date; id: string } | null = null
  for (;;) {
    const page: Awaited<ReturnType<PrismaClient['auditLog']['findMany']>> = await prisma.auditLog.findMany({
      where: (after
        ? {
            AND: [
              where,
              {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              },
            ],
          }
        : where) as Prisma.AuditLogWhereInput,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_PAGE_SIZE,
    })
    if (page.length === 0) return
    yield page
      .map((row) => {
        const entry = toAuditLogRecord(row)
        return csvRow(AUDIT_EXPORT_COLUMNS.map(([, value]) => value(entry)))
      })
      .join('')
    if (page.length < EXPORT_PAGE_SIZE) return
    const last = page[page.length - 1]
    if (!last) return
    after = { createdAt: last.createdAt, id: last.id }
  }
}

/**
 * The filters an export was taken with, as the trail records them: which
 * entries left, never the entries themselves.
 */
export const describeAuditExportFilters = (
  filters: Omit<AuditLogFilters, 'organizationId'>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(filters).flatMap(([key, value]) => {
      if (value === undefined || value === null || value === '') return []
      return [[key, value instanceof Date ? value.toISOString() : String(value)]]
    }),
  )
