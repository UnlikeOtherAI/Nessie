import { useRef } from 'react'
import { faFileLines, faFolder, faPaperclip } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { Pill } from '../../primitives/Pill'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import { SectionLabel } from '../../primitives/SectionLabel'
import { AgentDraftBadge } from './AgentDraftBadge'
import { BacklinksPanel } from './backlinks/BacklinksPanel'
import { CommentsSection } from './comments/CommentsSection'
import { KnowledgePane } from './KnowledgePane'
import { PageNotesLayer } from './notes/PageNotesLayer'
import { isAgentDraft, pageStatusPillTone } from './page-status'
import { ReviewPanel } from './ReviewPanel'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

type PagePreviewProps = {
  // The on-demand full-body fetch (the pages list omits bodies): loading gets
  // the shared line, a failure gets Retry, success renders the body below.
  bodyQuery: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  canWrite: boolean
  // On a phone the team owns the doorway through the local-back
  // registry and passes no onBack; wider layouts keep the pane's own Back.
  onBack?: () => void
  onCreateChild: () => void
  onDrill: (childPageId: string) => void
  onEdit: () => void
  onOpenHistory: () => void
  onPublish: () => void
  onToggleAttachments: () => void
  page: KnowledgePageRecord
  publishPending?: boolean
  subPages: KnowledgePageRecord[]
}

const sortedSubPages = (pages: KnowledgePageRecord[]): KnowledgePageRecord[] =>
  [...pages].sort((left, right) => {
    const leftFolder = (left.childPageIds?.length ?? 0) > 0
    const rightFolder = (right.childPageIds?.length ?? 0) > 0
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1
    return left.position - right.position || left.title.localeCompare(right.title)
  })

export const PagePreview = ({
  bodyQuery,
  canWrite,
  onBack,
  onCreateChild,
  onDrill,
  onEdit,
  onOpenHistory,
  onPublish,
  onToggleAttachments,
  page,
  publishPending,
  subPages,
}: PagePreviewProps) => {
  const commentsComposerRef = useRef<HTMLTextAreaElement>(null)
  const focusComments = () => {
    commentsComposerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    commentsComposerRef.current?.focus()
  }
  const headerActions: PageHeaderAction[] = [
    {
      icon: faPaperclip,
      id: 'attachments',
      label: 'Attachments',
      onSelect: onToggleAttachments,
      priority: 60,
    },
    {
      id: 'history',
      label: 'History',
      onSelect: onOpenHistory,
      priority: 50,
    },
    ...(canWrite
      ? [
          {
            id: 'edit',
            label: 'Edit',
            onSelect: onEdit,
            priority: 40,
          },
          {
            disabled: publishPending,
            id: 'publish',
            label: 'Publish',
            onSelect: onPublish,
            primary: true,
            priority: 100,
          },
        ] satisfies PageHeaderAction[]
      : []),
  ]

  return (
    <KnowledgePane
      actions={headerActions}
      onBack={onBack}
      title={page.title}
    >
      <div className="kb-reader mx-auto my-8 w-full max-w-3xl rounded-xl px-8 py-8 shadow-sm">
        <div className="flex items-center gap-2">
          <Pill size="sm" tone={pageStatusPillTone[page.status]}>
            {page.status}
          </Pill>
          {isAgentDraft(page) ? <AgentDraftBadge /> : null}
        </div>
        <h1 className="mt-3 text-3xl font-semibold text-[var(--tx)]">{page.title}</h1>
        {page.summary ? <p className="mt-2 text-[color:var(--tx2)]">{page.summary}</p> : null}
        <ReviewPanel
          canWrite={canWrite}
          onPublish={onPublish}
          onRequestChanges={focusComments}
          page={page}
          publishPending={publishPending}
        />
        {page.labels.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {page.labels.map((label) => (
              <Pill key={label} radius="chip" tone="muted" uppercase={false}>
                {label}
              </Pill>
            ))}
          </div>
        ) : null}

        <div className="mt-6">
          <QueryState
            errorLabel="Couldn’t load this page."
            loadingLabel="Loading…"
            query={bodyQuery}
          >
            {() =>
              page.latestVersion?.body ? (
                <PageNotesLayer
                  body={page.latestVersion.body}
                  canWrite={canWrite}
                  pageId={page.id}
                  versionId={page.latestVersion.id}
                />
              ) : (
                <p className="text-sm text-[color:var(--tx3)]">
                  {canWrite ? 'No content yet. Press Edit to start writing.' : 'No content yet.'}
                </p>
              )
            }
          </QueryState>
        </div>

        <BacklinksPanel pageId={page.id} />

        <CommentsSection canResolve={canWrite} composerRef={commentsComposerRef} pageId={page.id} />

        <div className="mt-10 border-t border-[color:var(--sep)] pt-6">
          <div className="flex items-center justify-between">
            <SectionLabel size="2xs">Sub-pages</SectionLabel>
            {canWrite ? (
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={onCreateChild}
                type="button"
              >
                New sub-page
              </button>
            ) : null}
          </div>
          <div className="mt-3">
            {subPages.length === 0 ? (
              <p className="py-4 text-sm text-[color:var(--tx3)]">No sub-pages yet.</p>
            ) : (
              <RowList>
                {sortedSubPages(subPages).map((child) => {
                  const isFolder = (child.childPageIds?.length ?? 0) > 0
                  return (
                    <Row
                      key={child.id}
                      leading={
                        <FontAwesomeIcon
                          className={[
                            'h-4 w-4',
                            isFolder ? 'text-[color:var(--accent)]' : 'text-[color:var(--tx3)]',
                          ].join(' ')}
                          fixedWidth
                          icon={isFolder ? faFolder : faFileLines}
                        />
                      }
                      onClick={() => onDrill(child.id)}
                      title={child.title}
                      trailing={
                        <>
                          {isAgentDraft(child) ? <AgentDraftBadge /> : null}
                          <Pill size="sm" tone={pageStatusPillTone[child.status]}>
                            {child.status}
                          </Pill>
                        </>
                      }
                    />
                  )
                })}
              </RowList>
            )}
          </div>
        </div>
      </div>
    </KnowledgePane>
  )
}
