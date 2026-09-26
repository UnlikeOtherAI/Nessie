/**
 * The audit log's filters, as the address holds them and as the API takes
 * them. They are state params of `/admin/security` (the registry row declares
 * them): a filtered trail is linkable, survives a reload, and an entry's page
 * opens its actor's or its action's entries by writing one of them.
 *
 * Pure, so the translation — above all the day boundaries — is tested without
 * a router.
 */

export const AUDIT_OUTCOME_FILTERS = ['all', 'success', 'denied', 'error'] as const
export type AuditOutcomeFilter = (typeof AUDIT_OUTCOME_FILTERS)[number]

/** Every param a filter owns, so leaving the audit tab can take them all. */
export const AUDIT_FILTER_PARAMS = ['actor', 'action', 'outcome', 'from', 'to', 'team', 'project'] as const

/** What a filter change drops with it: the page a cursor named is another result set's. */
export const AUDIT_PAGE_PARAMS = ['cursor', 'direction', 'page', 'trail'] as const

export type AuditFilterValues = {
  action: string
  actor: string
  from: string
  outcome: AuditOutcomeFilter
  project: string
  team: string
  to: string
}

/** The filters that are text in the address; the outcome is the strip's. */
export type AuditTextFilter = Exclude<keyof AuditFilterValues, 'outcome'>

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** A day as the date input writes it, or '' — a hand-typed value that is not one reads as unset. */
const day = (value: string | null): string => (value && DAY.test(value) ? value : '')

export const readAuditFilters = (params: URLSearchParams, outcome: AuditOutcomeFilter): AuditFilterValues => ({
  action: params.get('action') ?? '',
  actor: params.get('actor') ?? '',
  from: day(params.get('from')),
  outcome,
  project: params.get('project') ?? '',
  team: params.get('team') ?? '',
  to: day(params.get('to')),
})

export const hasAuditFilters = (filters: AuditFilterValues): boolean =>
  filters.outcome !== 'all'
  || [filters.action, filters.actor, filters.from, filters.to, filters.project, filters.team]
    .some((value) => value.length > 0)

/**
 * The day a person picked is a day where they are: `from` is its first
 * moment and `to` its last, in the browser's zone, sent as instants. A bare
 * `2026-09-01` would reach the server as UTC midnight and shift the boundary
 * by the reader's offset.
 */
const startOfDay = (value: string): string | undefined =>
  value ? new Date(`${value}T00:00:00.000`).toISOString() : undefined

const endOfDay = (value: string): string | undefined =>
  value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined

/** The list's (and the export's) query: the API's own names, unset ones left out. */
export const auditQueryParams = (filters: AuditFilterValues): Record<string, string | undefined> => ({
  action: filters.action || undefined,
  actorId: filters.actor || undefined,
  from: startOfDay(filters.from),
  outcome: filters.outcome === 'all' ? undefined : filters.outcome,
  projectId: filters.project || undefined,
  teamId: filters.team || undefined,
  to: endOfDay(filters.to),
})

/** One filter written into the address; every page param leaves with the old result set. */
export const withAuditFilter = (
  current: URLSearchParams,
  name: Exclude<AuditTextFilter, 'project' | 'team'>,
  value: string,
): URLSearchParams => {
  const next = new URLSearchParams(current)
  for (const owned of AUDIT_PAGE_PARAMS) next.delete(owned)
  if (value) next.set(name, value)
  else next.delete(name)
  return next
}

/** The Where choice's value for a team, a project, or anywhere (''). */
export const auditWhereValue = (filters: Pick<AuditFilterValues, 'project' | 'team'>): string =>
  filters.team ? `team:${filters.team}` : filters.project ? `project:${filters.project}` : ''

/**
 * Team and project are one "where" choice, written in one replace: naming one
 * clears the other, and "Anywhere" clears both. Two writes in one tick would
 * each start from the same address and the second would undo the first.
 */
export const withAuditWhere = (current: URLSearchParams, where: string): URLSearchParams => {
  const next = new URLSearchParams(current)
  for (const owned of [...AUDIT_PAGE_PARAMS, 'team', 'project']) next.delete(owned)
  if (where.startsWith('team:') && where.length > 'team:'.length) next.set('team', where.slice('team:'.length))
  if (where.startsWith('project:') && where.length > 'project:'.length) {
    next.set('project', where.slice('project:'.length))
  }
  return next
}

/** Every filter and page param gone; the tab and anything else the page holds stay. */
export const withoutAuditFilters = (current: URLSearchParams): URLSearchParams => {
  const next = new URLSearchParams(current)
  for (const owned of [...AUDIT_FILTER_PARAMS, ...AUDIT_PAGE_PARAMS]) next.delete(owned)
  return next
}

/** The address of Security's audit log narrowed to one filter — an entry's doorways. */
export const auditLogPath = (filter: Partial<Record<AuditTextFilter, string>>): string => {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(filter)) {
    if (value) params.set(name, value)
  }
  const search = params.toString()
  return `/admin/security${search ? `?${search}` : ''}`
}
