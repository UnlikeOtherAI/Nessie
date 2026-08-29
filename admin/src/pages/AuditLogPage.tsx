import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import { auditLogKeys } from '../lib/query-keys'
import { useApiClient } from '../providers/ApiClientProvider'
import { useAuthSession } from '../providers/AuthSessionProvider'

type AuditEntry = {
  id: string
  action: string
  actorType: string
  actorId: string
  resourceType: string
  resourceId: string | null
  outcome: string
  createdAt: string
  metadata: Record<string, unknown> | null
}

type AuditResponse = {
  data: AuditEntry[]
  meta: { cursor: string | null; hasMore: boolean }
}

export const AuditLogPage = () => {
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const [actionFilter, setActionFilter] = useState('')
  const isOwner = me?.user.roleIds.includes('owner') ?? false

  const { data } = useQuery<AuditResponse>({
    queryKey: auditLogKeys.forAction(actionFilter),
    queryFn: () => {
      const params = new URLSearchParams()
      if (actionFilter) params.set('action', actionFilter)
      params.set('limit', '50')
      return apiClient.get(`/api/audit-log?${params.toString()}`)
    },
    enabled: isOwner,
  })

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <AdminPageHeader title="Audit Log" />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-4 w-full max-w-xs">
          <input
            className="admin-input"
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder="Filter by action..."
            value={actionFilter}
          />
        </div>
        <div className="grid gap-2">
          {(data?.data ?? []).map((entry) => (
            <div key={entry.id} className="admin-card p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-[color:var(--tx)]">
                    {entry.action}
                  </span>
                  <span
                    className={[
                      'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em]',
                      entry.outcome === 'success'
                        ? 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]'
                        : 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
                    ].join(' ')}
                  >
                    {entry.outcome}
                  </span>
                </div>
                <span className="text-xs text-[color:var(--tx3)]">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx2)]">
                {entry.actorType}:{entry.actorId.slice(0, 8)} &rarr;{' '}
                {entry.resourceType}
                {entry.resourceId ? `:${entry.resourceId.slice(0, 8)}` : ''}
              </div>
            </div>
          ))}
          {(data?.data ?? []).length === 0 && (
            <div className="py-8 text-center text-[color:var(--tx3)]">
              No audit events found
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
