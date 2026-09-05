import { useRef, useState } from 'react'
import {
  faBoxArchive,
  faClockRotateLeft,
  faEllipsis,
  faFileLines,
  faFolder,
  faPaperclip,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { toFormErrors } from '../../../facades/form-errors'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { Pill } from '../../primitives/Pill'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
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
  breadcrumbPages: KnowledgePageRecord[]
  archivePending?: boolean
  canWrite: boolean
  // On a phone the team owns the doorway through the local-back
  // registry and passes no onBack; wider layouts keep the pane's own Back.
  onBack?: () => void
  onArchive: () => Promise<void>
  onBrowseRoot: () => void
  onCreateChild: () => void
  onDrill: (childPageId: string) => void
  onEdit: () => void
  onOpenHistory: () => void
  onOpenBreadcrumb: (pageId: string) => void
  onPublish: () => void
  onToggleAttachments: () => void
  page: KnowledgePageRecord
  publishPending?: boolean
  subPages: KnowledgePageRecord[]
  spaceName: string
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
  breadcrumbPages,
  archivePending,
  canWrite,
  onBack,
  onArchive,
  onBrowseRoot,
  onCreateChild,
  onDrill,
  onEdit,
  onOpenHistory,
  onOpenBreadcrumb,
  onPublish,
  onToggleAttachments,
  page,
  publishPending,
  subPages,
  spaceName,
}: PagePreviewProps) => {
  const commentsComposerRef = useRef<HTMLTextAreaElement>(null)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const focusComments = () => {
    commentsComposerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    commentsComposerRef.current?.focus()
  }
  const headerActions: PageHeaderAction[] = [
    ...(canWrite
      ? [{
          id: 'new-sub-page',
          label: 'New page',
          onSelect: onCreateChild,
          // Creating is the primary here only once Publish has left the row:
          // a draft's reason to be open is publishing it, and two filled
          // buttons side by side name no decision.
          primary: page.status === 'published',
          priority: 90,
        } satisfies PageHeaderAction]
      : []),
    {
      icon: faPaperclip,
      id: 'attachments',
      label: 'Attachments',
      onSelect: onToggleAttachments,
      priority: 60,
    },
    ...(canWrite
      ? [
          {
            id: 'edit',
            label: 'Edit',
            onSelect: onEdit,
            priority: 40,
          },
          ...(page.status !== 'published'
            ? [{
                disabled: publishPending,
                id: 'publish',
                label: 'Publish',
                onSelect: onPublish,
                primary: true,
                priority: 100,
              } satisfies PageHeaderAction]
            : []),
        ] satisfies PageHeaderAction[]
      : []),
    {
      compact: true,
      icon: faEllipsis,
      id: 'page-actions',
      items: [
        {
          icon: faClockRotateLeft,
          id: 'history',
          label: 'History',
          onSelect: onOpenHistory,
        },
        ...(canWrite
          ? [{
              disabled: archivePending,
              icon: faBoxArchive,
              id: 'archive-page',
              label: 'Archive page',
              onSelect: () => {
                setArchiveError(null)
                setArchiveConfirmOpen(true)
              },
            }]
          : []),
      ],
      kind: 'menu',
      label: 'Page actions',
      priority: 10,
    },
  ]

  return (
    <KnowledgePane
      actions={headerActions}
      onBack={onBack}
      title={page.title}
    >
      <div className="kb-reader mx-auto my-8 w-full max-w-3xl rounded-xl px-8 py-8 shadow-sm">
        <nav aria-label="Page breadcrumbs" className="admin-breadcrumbs mb-5 flex flex-wrap items-center gap-1 text-[13px] text-[color:var(--tx3)]">
          <button className="hover:text-[color:var(--tx)]" onClick={onBrowseRoot} type="button">
            {spaceName}
          </button>
          {breadcrumbPages.map((breadcrumb) => (
            <span className="flex items-center gap-1" key={breadcrumb.id}>
              <span aria-hidden="true">/</span>
              <button
                className="hover:text-[color:var(--tx)]"
                onClick={() => onOpenBreadcrumb(breadcrumb.id)}
                type="button"
              >
                {breadcrumb.title}
              </button>
            </span>
          ))}
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="text-[color:var(--tx2)]">{page.title}</span>
        </nav>
        <div className="flex items-center gap-2">
          {page.status !== 'published' ? (
            <Pill size="sm" tone={pageStatusPillTone[page.status]}>
              {page.status}
            </Pill>
          ) : null}
          {isAgentDraft(page) ? <AgentDraftBadge /> : null}
        </div>
        <h1 className="admin-document-title mt-3 text-[40px] font-normal leading-[1.15] text-[var(--tx)]">{page.title}</h1>
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
                New page
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
      <ConfirmDialog
        body={
          <>
            <p>The page will be removed from this space. Its version history is retained.</p>
            {archiveError ? (
              <p className="mt-2 text-[color:var(--danger-text)]" role="alert">{archiveError}</p>
            ) : null}
          </>
        }
        confirmLabel={archivePending ? 'Archiving…' : 'Archive page'}
        destructive
        onCancel={() => {
          setArchiveConfirmOpen(false)
          setArchiveError(null)
        }}
        onConfirm={() => {
          setArchiveError(null)
          void onArchive()
            .then(() => setArchiveConfirmOpen(false))
            .catch((error: unknown) => {
              setArchiveError(toFormErrors(error).formError ?? 'Unable to archive this page.')
            })
        }}
        open={archiveConfirmOpen}
        pending={archivePending}
        title={`Archive “${page.title}”?`}
      />
    </KnowledgePane>
  )
}
