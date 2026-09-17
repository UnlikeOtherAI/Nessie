import { z } from 'zod'

/**
 * The audit-log list and summary queries, as they arrive on the wire.
 *
 * The compliance surface is where operators go to diagnose other incidents,
 * so its own failure modes matter more than most: `?from=banana` used to
 * become `new Date('banana')` — an `Invalid Date` that node-postgres rejects
 * with a `RangeError` at parameter-serialisation time, answering 500 for a
 * mistyped filter. `z.coerce.date` keeps accepting everything `new Date`
 * accepted (ISO timestamps, date-only strings) and rejects only what has no
 * parse at all, which is exactly the 400 line.
 *
 * `groupBy` is an enum rather than a string because the summary route maps it
 * through a column whitelist: anything outside the keys was silently grouped
 * by `action`, which reads as a correct answer to a question nobody asked.
 *
 * `limit` and `direction` stay strings on purpose: the route's `parseInt` +
 * `resolvePageLimit` clamp and its backward/forward mapping are the existing
 * lenient contract, and this schema's job is to close the date hole, not to
 * tighten filters that already fail safe.
 */
export const AuditLogQuerySchema = z.object({
  action: z.string().optional(),
  actorId: z.string().optional(),
  channelId: z.string().optional(),
  cursor: z.string().optional(),
  direction: z.string().optional(),
  from: z.coerce.date().optional(),
  limit: z.string().optional(),
  outcome: z.string().optional(),
  projectId: z.string().optional(),
  resourceId: z.string().optional(),
  resourceType: z.string().optional(),
  teamId: z.string().optional(),
  to: z.coerce.date().optional(),
})
export type AuditLogQueryParams = z.infer<typeof AuditLogQuerySchema>

export const AUDIT_LOG_SUMMARY_GROUPINGS = ['action', 'actorId', 'resourceType', 'outcome'] as const

export const AuditLogSummaryQuerySchema = z.object({
  from: z.coerce.date().optional(),
  groupBy: z.enum(AUDIT_LOG_SUMMARY_GROUPINGS).optional(),
  to: z.coerce.date().optional(),
})
export type AuditLogSummaryQueryParams = z.infer<typeof AuditLogSummaryQuerySchema>
