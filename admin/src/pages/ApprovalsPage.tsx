import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import { approvalKeys } from '../lib/query-keys'
import { useApiClient } from '../providers/ApiClientProvider'
import { useAuthSession } from '../providers/AuthSessionProvider'

type ApprovalRequest = {
  id: string
  agentId: string
  action: string
  reason: string
  context?: Record<string, unknown>
  status: string
  requesterId: string
  resolverId: string | null
  resolution: string | null
  resolutionNote: string | null
  expiresAt: string
  createdAt: string
}

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const KNOWLEDGE_PAGE_PUBLISH_ACTION = 'knowledge.page.publish'

type KnowledgePagePublishContext = {
  pageId: string
  versionId: string
  spaceId: string
  title: string
}

// Narrows an approval's opaque `context` blob to the shape the knowledge-base
// publish action always sends. Returns null for anything malformed so the UI
// falls back to the generic action-name rendering rather than crashing.
const readKnowledgePagePublishContext = (
  approval: ApprovalRequest,
): KnowledgePagePublishContext | null => {
  if (approval.action !== KNOWLEDGE_PAGE_PUBLISH_ACTION) return null
  const context = approval.context
  if (!context) return null
  const { pageId, versionId, spaceId, title } = context
  if (
    typeof pageId === 'string' &&
    typeof versionId === 'string' &&
    typeof spaceId === 'string' &&
    typeof title === 'string'
  ) {
    return { pageId, versionId, spaceId, title }
  }
  return null
}

export const ApprovalsPage = () => {
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // apiClient unwraps the {data, meta} envelope and returns the payload array
  // directly — typing the full envelope here made `data?.data` permanently
  // undefined, so the page rendered empty even with pending approvals.
  const { data } = useQuery<ApprovalRequest[]>({
    queryKey: approvalKeys.all,
    queryFn: () => apiClient.get('/api/approvals?limit=50'),
    enabled: Boolean(me),
  })

  const resolve = useMutation({
    mutationFn: (input: { id: string; resolution: 'approved' | 'rejected' }) =>
      apiClient.post(`/api/approvals/${input.id}/resolve`, {
        resolution: input.resolution,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: approvalKeys.all })
    },
  })

  const pending = (data ?? []).filter((a) => a.status === 'pending')
  const resolved = (data ?? []).filter((a) => a.status !== 'pending')

  return (
    <section className="flex h-full min-h-0 flex-col">
      <AdminPageHeader title="Approvals" />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {pending.length > 0 ? (
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--warning-text)]">
            {pending.length} pending
          </div>
        ) : null}
        {pending.length > 0 && (
          <div className="mb-4">
            <div className={sectionTitle}>Pending</div>
            <div className="mt-2 grid gap-2">
              {pending.map((approval) => {
                const knowledgePublish = readKnowledgePagePublishContext(approval)
                return (
                <div key={approval.id} className="admin-card p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      {knowledgePublish ? (
                        <span className="text-sm font-semibold text-[color:var(--tx)]">
                          Publish knowledge page: {knowledgePublish.title}
                        </span>
                      ) : (
                        <span className="font-mono text-sm font-semibold text-[color:var(--tx)]">
                          {approval.action}
                        </span>
                      )}
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
                  {knowledgePublish ? (
                    <div className="mt-2">
                      <button
                        className="admin-button admin-button-secondary admin-button-compact"
                        onClick={() =>
                          navigate(
                            `/knowledge-base?spaceId=${knowledgePublish.spaceId}&pageId=${knowledgePublish.pageId}`,
                          )
                        }
                        type="button"
                      >
                        Open page
                      </button>
                    </div>
                  ) : null}
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
                )
              })}
            </div>
          </div>
        )}

        <div>
          <div className={sectionTitle}>History</div>
          <div className="mt-2 grid gap-2">
            {resolved.map((approval) => {
              const knowledgePublish = readKnowledgePagePublishContext(approval)
              return (
              <div key={approval.id} className="admin-card p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {knowledgePublish ? (
                      <span className="text-xs text-[color:var(--tx)]">
                        Publish knowledge page: {knowledgePublish.title}
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-[color:var(--tx)]">{approval.action}</span>
                    )}
                    <span
                      className={[
                        'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em]',
                        approval.status === 'approved'
                          ? 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]'
                          : approval.status === 'rejected'
                            ? 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]'
                            : 'bg-[color:var(--overlay)] text-[color:var(--tx3)]',
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
              )
            })}
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
