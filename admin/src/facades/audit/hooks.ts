import { useQuery } from '@tanstack/react-query'

import { downloadAuthedPath } from '../../lib/uploads'
import { useApiClient } from '../../providers/ApiClientProvider'
import { usePagedList } from '../pagination/usePagedList'
import { auditLogKeys } from './keys'

/**
 * The audit trail behind Admin › Security. Every read here is the owner's
 * (`GET /api/audit-log*` is `requireOwner`), so each hook takes `enabled` and
 * the page passes the same owner flag its gate asks, rather than issuing a
 * request the server is going to refuse.
 */

export type AuditEntry = {
  action: string
  actorId: string
  actorType: string
  channelId: string | null
  createdAt: string
  id: string
  ipAddress: string | null
  metadata: Record<string, unknown> | null
  outcome: string
  projectId: string | null
  reason: string | null
  requestId: string
  resourceId: string | null
  resourceType: string
  teamId: string | null
  userAgent: string | null
}

/** `GET /api/audit-log/verify`: the chain walk, and what it could not check. */
export type AuditVerification = {
  checkedCount: number
  firstBreak?: { id: string; reason: string }
  /** Entries written before the hash chain existed, which carry no hash. */
  unchainedCount: number
  valid: boolean
}

type AuditSummary = { entries: Array<{ count: number; key: string }>; groupBy: string }

export const useAuditLog = (params: Record<string, string | undefined>, enabled: boolean) =>
  usePagedList<AuditEntry>({
    enabled,
    params,
    path: '/api/audit-log',
    queryKey: auditLogKeys.entries,
  })

export const useAuditEntry = (entryId: string | undefined, enabled: boolean) => {
  const api = useApiClient()
  return useQuery<AuditEntry>({
    enabled: enabled && Boolean(entryId),
    queryFn: () => api.get(`/api/audit-log/${encodeURIComponent(entryId ?? '')}`),
    queryKey: auditLogKeys.entry(entryId ?? ''),
  })
}

/**
 * Which actions, or which actors, the trail holds — most frequent first. The
 * filters offer these rather than a free-text box: the list filters by exact
 * value, so a typed "member" would match nothing.
 */
export const useAuditSummary = (groupBy: 'action' | 'actorId', enabled: boolean) => {
  const api = useApiClient()
  return useQuery<AuditSummary>({
    enabled,
    queryFn: () => api.get(`/api/audit-log/summary?groupBy=${groupBy}`),
    queryKey: auditLogKeys.summary(groupBy),
  })
}

/**
 * The chain walk, run when a person asks and not on arrival: it reads every
 * entry, and its answer is only worth having at the moment somebody wants it.
 */
export const useAuditVerification = (requested: boolean) => {
  const api = useApiClient()
  return useQuery<AuditVerification>({
    enabled: requested,
    gcTime: 0,
    queryFn: () => api.get('/api/audit-log/verify'),
    queryKey: auditLogKeys.verification,
    staleTime: 0,
  })
}

/**
 * Downloads every entry the filters match (`GET /api/audit-log/export`). The
 * bytes need the session's bearer token, so this is a fetch handed to a
 * transient link rather than a plain `<a href>`.
 */
export const downloadAuditExport = (
  params: Record<string, string | undefined>,
  token: string | null,
  today: Date = new Date(),
): Promise<void> => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const query = search.toString()
  const day = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-')
  return downloadAuthedPath(
    `/api/audit-log/export${query ? `?${query}` : ''}`,
    `audit-log-${day}.csv`,
    token,
  )
}
