import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { ApprovalDecision } from '../components/features/approvals/ApprovalDecision'
import { EmailApprovalReviewDialog } from '../components/features/approvals/EmailApprovalReviewDialog'
import { Pill } from '../components/primitives/Pill'
import { PageBody, Section } from '../components/shared/PageBody'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { QueryState } from '../components/shared/QueryState'
import { Row, RowList } from '../components/shared/RowList'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { type ApprovalRequest } from '../facades/approvals/hooks'
import { approvalKeys } from '../lib/query-keys'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { usePagedList } from '../facades/usePagedList'

const KNOWLEDGE_PAGE_PUBLISH_ACTION = 'knowledge.page.publish'
const TODO_TEMPLATE_PUBLISH_ACTION = 'agent.todo_template.publish'
const REVIEWABLE_EMAIL_TOOL_NAMES = new Set(['gmail_draft_send', 'mailbox_send'])

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
    typeof pageId === 'string'
    && typeof versionId === 'string'
    && typeof spaceId === 'string'
    && typeof title === 'string'
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

const approvalTitle = (approval: ApprovalRequest): string => {
  const knowledgePublish = readKnowledgePagePublishContext(approval)
  if (knowledgePublish) return `Publish knowledge page: ${knowledgePublish.title}`
  const todoTemplatePublish = readTodoTemplatePublishContext(approval)
  if (todoTemplatePublish) {
    return `Publish to-do template: ${approval.reason.replace('Agent-proposed to-do template: ', '')}`
  }
  return approval.action
}

const isReviewableEmailApproval = (approval: ApprovalRequest): boolean =>
  approval.action === 'tool.invoke'
  && typeof approval.context?.['toolName'] === 'string'
  && REVIEWABLE_EMAIL_TOOL_NAMES.has(approval.context['toolName'])

export const ApprovalsPage = () => {
  const navigate = useNavigate()
  const { me } = useAuthSession()
  const [reviewingApproval, setReviewingApproval] = useState<ApprovalRequest | null>(null)

  // Not raw keys: `approvalKeys.all` is the factory; 'pending'/'history' only
  // distinguish this page's two cache entries from each other and from any
  // other use of that root. See AuditLogPage's identical note.
  const pendingCacheKey = [...approvalKeys.all, 'pending']
  const historyCacheKey = [...approvalKeys.all, 'history']

  const pending = usePagedList<ApprovalRequest>({
    enabled: Boolean(me),
    params: { status: 'pending' },
    paramPrefix: 'pending-',
    path: '/api/approvals',
    queryKey: pendingCacheKey,
  })
  // The API filters by exact status, with no "not pending" value — so history
  // reads the general feed and drops pending rows at render time. Pending is
  // shown in its own section above, so this only ever de-duplicates.
  const history = usePagedList<ApprovalRequest>({
    enabled: Boolean(me),
    paramPrefix: 'history-',
    path: '/api/approvals',
    queryKey: historyCacheKey,
  })
  const historyItems = history.items.filter((approval) => approval.status !== 'pending')

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader title="Approvals" />

      <PageBody>
        <Section
          actions={
            pending.items.length > 0 ? (
              <Pill radius="chip" size="sm" tone="warning">
                {pending.items.length} pending
              </Pill>
            ) : undefined
          }
          title="Pending"
        >
          <QueryState
            emptyLabel="Nothing waiting on you"
            errorLabel="Pending approvals could not be loaded."
            isEmpty={pending.items.length === 0}
            loadingLabel="Loading pending approvals…"
            query={pending.query}
          >
            {() => (
              <>
                <RowList label="Pending approvals">
                  {pending.items.map((approval) => {
                    const knowledgePublish = readKnowledgePagePublishContext(approval)
                    const todoTemplatePublish = readTodoTemplatePublishContext(approval)
                    return (
                      <Row
                        key={approval.id}
                        subtitle={approval.reason}
                        title={
                          <span className="flex flex-wrap items-baseline gap-2">
                            <span
                              className={
                                knowledgePublish || todoTemplatePublish
                                  ? 'text-[color:var(--tx)]'
                                  : 'font-mono text-[color:var(--tx)]'
                              }
                            >
                              {approvalTitle(approval)}
                            </span>
                            <span className="text-xs text-[color:var(--tx3)]">
                              Agent: {approval.agentId.slice(0, 8)}
                            </span>
                          </span>
                        }
                        trailing={
                          <span className="text-xs text-[color:var(--tx3)]">
                            Expires: {new Date(approval.expiresAt).toLocaleTimeString()}
                          </span>
                        }
                      >
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {knowledgePublish ? (
                            <button
                              className="admin-button admin-button-secondary admin-button-compact"
                              onClick={() =>
                                navigate(
                                  `/knowledge-base?spaceId=${knowledgePublish.spaceId}&pageId=${knowledgePublish.pageId}`,
                                )}
                              type="button"
                            >
                              Open page
                            </button>
                          ) : null}
                          {todoTemplatePublish ? (
                            <button
                              className="admin-button admin-button-secondary admin-button-compact"
                              onClick={() => navigate(`/agents/${approval.agentId}?tab=todos`)}
                              type="button"
                            >
                              Open to-dos
                            </button>
                          ) : null}
                          {isReviewableEmailApproval(approval) ? (
                            <button
                              className="admin-button admin-button-primary"
                              data-testid="approval-review-email"
                              onClick={() => setReviewingApproval(approval)}
                              type="button"
                            >
                              Review email
                            </button>
                          ) : (
                            <ApprovalDecision
                              approvalId={approval.id}
                              description="This lets the agent continue with the proposed action."
                            />
                          )}
                        </div>
                      </Row>
                    )
                  })}
                </RowList>
                <PaginationFooter
                  canNext={pending.canNext}
                  canPrevious={pending.canPrevious}
                  hideWhenSinglePage
                  label={pending.label}
                  onPageChange={pending.onPageChange}
                  onPageSizeChange={pending.onPageSizeChange}
                  page={pending.page}
                  pageCount={pending.pageCount}
                  pageSize={pending.pageSize}
                />
              </>
            )}
          </QueryState>
        </Section>

        <Section title="History">
          <QueryState
            emptyLabel="No approvals yet"
            errorLabel="Approval history could not be loaded."
            isEmpty={historyItems.length === 0}
            loadingLabel="Loading approval history…"
            query={history.query}
          >
            {() => (
              <>
                <RowList label="Approval history">
                  {historyItems.map((approval) => (
                    <Row
                      key={approval.id}
                      title={
                        <span className="flex items-center gap-2">
                          <span
                            className={
                              readKnowledgePagePublishContext(approval) || readTodoTemplatePublishContext(approval)
                                ? 'text-[color:var(--tx)]'
                                : 'font-mono text-[color:var(--tx)]'
                            }
                          >
                            {approvalTitle(approval)}
                          </span>
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
                        </span>
                      }
                      trailing={
                        <span className="text-xs text-[color:var(--tx3)]">
                          {new Date(approval.createdAt).toLocaleString()}
                        </span>
                      }
                    />
                  ))}
                </RowList>
                <PaginationFooter
                  canNext={history.canNext}
                  canPrevious={history.canPrevious}
                  hideWhenSinglePage
                  label={history.label}
                  onPageChange={history.onPageChange}
                  onPageSizeChange={history.onPageSizeChange}
                  page={history.page}
                  pageCount={history.pageCount}
                  pageSize={history.pageSize}
                />
              </>
            )}
          </QueryState>
        </Section>
      </PageBody>
      <EmailApprovalReviewDialog
        approval={reviewingApproval}
        onClose={() => setReviewingApproval(null)}
        open={reviewingApproval !== null}
      />
    </section>
  )
}
