import { useNavigate } from 'react-router-dom'
import { Pill } from '../components/primitives/Pill'
import { SectionLabel } from '../components/primitives/SectionLabel'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { useApprovalRequests, useResolveApproval, type ApprovalRequest } from '../facades/approvals/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

const KNOWLEDGE_PAGE_PUBLISH_ACTION = 'knowledge.page.publish'
const TODO_TEMPLATE_PUBLISH_ACTION = 'agent.todo_template.publish'

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

const readTodoTemplatePublishContext = (approval: ApprovalRequest): {
  templateId: string
  version: number
} | null => {
  if (approval.action !== TODO_TEMPLATE_PUBLISH_ACTION) return null
  const context = approval.context
  if (!context || typeof context.templateId !== 'string' || typeof context.version !== 'number') return null
  return { templateId: context.templateId, version: context.version }
}

export const ApprovalsPage = () => {
  const { me } = useAuthSession()
  const navigate = useNavigate()

  // apiClient unwraps the {data, meta} envelope and returns the payload array
  // directly — typing the full envelope here made `data?.data` permanently
  // undefined, so the page rendered empty even with pending approvals.
  const { data } = useApprovalRequests(Boolean(me))
  const resolve = useResolveApproval()

  const pending = (data ?? []).filter((a) => a.status === 'pending')
  const resolved = (data ?? []).filter((a) => a.status !== 'pending')

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader title="Approvals" />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {pending.length > 0 ? (
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--warning-text)]">
            {pending.length} pending
          </div>
        ) : null}
        {pending.length > 0 && (
          <div className="mb-4">
            <SectionLabel>Pending</SectionLabel>
            <div className="mt-2 grid gap-2">
              {pending.map((approval) => {
                const knowledgePublish = readKnowledgePagePublishContext(approval)
                const todoTemplatePublish = readTodoTemplatePublishContext(approval)
                return (
                <div key={approval.id} className="admin-card p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      {knowledgePublish ? (
                        <span className="text-sm font-semibold text-[color:var(--tx)]">
                          Publish knowledge page: {knowledgePublish.title}
                        </span>
                      ) : todoTemplatePublish ? (
                        <span className="text-sm font-semibold text-[color:var(--tx)]">
                          Publish to-do template: {approval.reason.replace('Agent-proposed to-do template: ', '')}
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
                  {todoTemplatePublish ? (
                    <div className="mt-2">
                      <button
                        className="admin-button admin-button-secondary admin-button-compact"
                        onClick={() => navigate(`/agents/${approval.agentId}?tab=todos`)}
                        type="button"
                      >
                        Open to-dos
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
          <SectionLabel>History</SectionLabel>
          <div className="mt-2 grid gap-2">
            {resolved.map((approval) => {
              const knowledgePublish = readKnowledgePagePublishContext(approval)
              const todoTemplatePublish = readTodoTemplatePublishContext(approval)
              return (
              <div key={approval.id} className="admin-card p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {knowledgePublish ? (
                      <span className="text-xs text-[color:var(--tx)]">
                        Publish knowledge page: {knowledgePublish.title}
                      </span>
                    ) : todoTemplatePublish ? (
                      <span className="text-xs text-[color:var(--tx)]">
                        Publish to-do template: {approval.reason.replace('Agent-proposed to-do template: ', '')}
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-[color:var(--tx)]">{approval.action}</span>
                    )}
                    <Pill
                      radius="chip"
                      size="sm"
                      tone={
                        approval.status === 'approved'
                          ? 'success'
                          : approval.status === 'rejected'
                            ? 'danger'
                            : 'muted'
                      }
                    >
                      {approval.status}
                    </Pill>
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
