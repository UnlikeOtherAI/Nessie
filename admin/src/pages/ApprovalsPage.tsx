import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../providers/ApiClientProvider'
import { useAuthSession } from '../providers/AuthSessionProvider'

type ApprovalRequest = {
  id: string
  agentId: string
  action: string
  reason: string
  status: string
  requesterId: string
  resolverId: string | null
  resolution: string | null
  resolutionNote: string | null
  expiresAt: string
  createdAt: string
}

type ApprovalsResponse = {
  data: ApprovalRequest[]
  meta: { cursor: string | null; hasMore: boolean }
}

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const ApprovalsPage = () => {
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  const { data } = useQuery<ApprovalsResponse>({
    queryKey: ['approvals'],
    queryFn: () => apiClient.get('/api/approvals?limit=50'),
    enabled: Boolean(me),
  })

  const resolve = useMutation({
    mutationFn: (input: { id: string; resolution: 'approved' | 'rejected' }) =>
      apiClient.post(`/api/approvals/${input.id}/resolve`, {
        resolution: input.resolution,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['approvals'] })
    },
  })

  const pending = (data?.data ?? []).filter((a) => a.status === 'pending')
  const resolved = (data?.data ?? []).filter((a) => a.status !== 'pending')

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center border-b border-[color:var(--sep)] px-5">
        <div className={sectionTitle}>Approvals</div>
        {pending.length > 0 && (
          <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-400">
            {pending.length} pending
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {pending.length > 0 && (
          <div className="mb-4">
            <div className={sectionTitle}>Pending</div>
            <div className="mt-2 grid gap-2">
              {pending.map((approval) => (
                <div key={approval.id} className="admin-card p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-mono text-sm font-semibold text-white">
                        {approval.action}
                      </span>
                      <span className="ml-2 text-xs text-[color:var(--tx3)]">
                        Agent: {approval.agentId.slice(0, 8)}
                      </span>
                    </div>
                    <span className="text-xs text-[color:var(--tx3)]">
                      Expires: {new Date(approval.expiresAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-[color:var(--tx2)]">
                    {approval.reason}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      className="admin-button admin-button-primary"
                      disabled={resolve.isPending}
                      onClick={() =>
                        resolve.mutate({ id: approval.id, resolution: 'approved' })
                      }
                      type="button"
                    >
                      Approve
                    </button>
                    <button
                      className="admin-button admin-button-secondary"
                      disabled={resolve.isPending}
                      onClick={() =>
                        resolve.mutate({ id: approval.id, resolution: 'rejected' })
                      }
                      type="button"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className={sectionTitle}>History</div>
          <div className="mt-2 grid gap-2">
            {resolved.map((approval) => (
              <div key={approval.id} className="admin-card p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-white">{approval.action}</span>
                    <span
                      className={[
                        'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em]',
                        approval.status === 'approved'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : approval.status === 'rejected'
                            ? 'bg-red-500/15 text-red-400'
                            : 'bg-white/10 text-[color:var(--tx3)]',
                      ].join(' ')}
                    >
                      {approval.status}
                    </span>
                  </div>
                  <span className="text-xs text-[color:var(--tx3)]">
                    {new Date(approval.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
            {resolved.length === 0 && pending.length === 0 && (
              <div className="py-8 text-center text-[color:var(--tx3)]">
                No approvals yet
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
