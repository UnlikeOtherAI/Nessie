import { useRef } from 'react'
import { faFileLines, faFolder, faPaperclip } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { AgentDraftBadge } from './AgentDraftBadge'
import { BacklinksPanel } from './backlinks/BacklinksPanel'
import { CommentsSection } from './comments/CommentsSection'
import { KnowledgePane } from './KnowledgePane'
import { PageNotesLayer } from './notes/PageNotesLayer'
import { isAgentDraft, pageStatusTone } from './page-status'
import { ReviewPanel } from './ReviewPanel'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

type PagePreviewProps = {
  // True while the page body is still being fetched on demand (the list omits it).
  bodyPending?: boolean
  canWrite: boolean
  // On a phone the workspace owns the doorway through the local-back
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
  bodyPending,
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
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em]">
          <span className={pageStatusTone[page.status]}>{page.status}</span>
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
              <span
                className="rounded bg-[var(--overlay-weak)] px-2 py-1 text-xs text-[color:var(--tx2)]"
                key={label}
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}

        {bodyPending ? (
          <div className="mt-6">
            <p className="text-sm text-[color:var(--tx3)]">Loading…</p>
          </div>
        ) : page.latestVersion?.body ? (
          <PageNotesLayer
            body={page.latestVersion.body}
            canWrite={canWrite}
            pageId={page.id}
            versionId={page.latestVersion.id}
          />
        ) : (
          <div className="mt-6">
            <p className="text-sm text-[color:var(--tx3)]">
              {canWrite ? 'No content yet. Press Edit to start writing.' : 'No content yet.'}
            </p>
          </div>
        )}

        <BacklinksPanel pageId={page.id} />

        <CommentsSection canResolve={canWrite} composerRef={commentsComposerRef} pageId={page.id} />

        <div className="mt-10 border-t border-[color:var(--sep)] pt-6">
          <div className="flex items-center justify-between">
            {/* SectionLabel cannot express tracking-[0.18em] at text-xs (xs is 0.2em, 2xs is 11px). */}
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
              Sub-pages
            </span>
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
          <div className="mt-3 grid gap-1">
            {subPages.length === 0 ? (
              <div className="py-4 text-sm text-[color:var(--tx3)]">No sub-pages yet.</div>
            ) : (
              sortedSubPages(subPages).map((child) => {
                const isFolder = (child.childPageIds?.length ?? 0) > 0
                return (
                  <button
                    className={[
                      'flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm',
                      'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[var(--tx)]',
                    ].join(' ')}
                    key={child.id}
                    onClick={() => onDrill(child.id)}
                    type="button"
                  >
                    <FontAwesomeIcon
                      className={[
                        'h-4 w-4 flex-shrink-0',
                        isFolder ? 'text-[color:var(--accent)]' : 'text-[color:var(--tx3)]',
                      ].join(' ')}
                      fixedWidth
                      icon={isFolder ? faFolder : faFileLines}
                    />
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    {isAgentDraft(child) ? <AgentDraftBadge /> : null}
                    <span className={`text-[10px] uppercase tracking-[0.14em] ${pageStatusTone[child.status]}`}>
                      {child.status}
                    </span>
                    <span aria-hidden className="opacity-60">
                      →
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>
    </KnowledgePane>
  )
}
