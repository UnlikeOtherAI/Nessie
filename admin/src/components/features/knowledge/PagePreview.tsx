import { useRef, useState } from 'react'
import {
  faBoxArchive,
  faClockRotateLeft,
  faEllipsis,
  faPaperclip,
  faPen,
} from '@fortawesome/free-solid-svg-icons'
import { toFormErrors } from '../../../facades/forms/form-errors'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { Pill } from '../../primitives/Pill'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { QueryState } from '../../shared/QueryState'
import { AgentDraftBadge } from './AgentDraftBadge'
import { BacklinksPanel } from './backlinks/BacklinksPanel'
import { CommentsSection } from './comments/CommentsSection'
import { KnowledgePane } from './KnowledgePane'
import { PageNotesLayer } from './notes/PageNotesLayer'
import { isAgentDraft, pageStatusPillTone } from './page-status'
import { ReviewPanel } from './ReviewPanel'
import { AttachmentsDrawer } from './AttachmentsDrawer'
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
  onEdit: () => void
  onOpenHistory: () => void
  onOpenBreadcrumb: (pageId: string) => void
  onPublish: () => void
  onToggleAttachments: () => void
  page: KnowledgePageRecord
  publishPending?: boolean
  spaceName: string
}

export const PagePreview = ({
  bodyQuery,
  breadcrumbPages,
  archivePending,
  canWrite,
  onBack,
  onArchive,
  onBrowseRoot,
  onEdit,
  onOpenHistory,
  onOpenBreadcrumb,
  onPublish,
  onToggleAttachments,
  page,
  publishPending,
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
    {
      compact: true,
      icon: faPaperclip,
      id: 'attachments',
      label: 'Attachments',
      onSelect: onToggleAttachments,
      priority: 60,
      title: 'Show attachments',
    },
    ...(canWrite
      ? [{
          compact: true,
          icon: faPen,
          id: 'edit',
          label: 'Edit',
          onSelect: onEdit,
          priority: 50,
          title: 'Edit document',
        } satisfies PageHeaderAction]
      : []),
    {
      compact: true,
      icon: faClockRotateLeft,
      id: 'history',
      label: 'History',
      onSelect: onOpenHistory,
      priority: 40,
      title: 'Version history',
    },
    ...(canWrite
      ? [{
          compact: true,
          icon: faEllipsis,
          id: 'document-actions',
          items: [{
            disabled: archivePending,
            icon: faBoxArchive,
            id: 'archive-page',
            label: 'Archive document',
            onSelect: () => {
              setArchiveError(null)
              setArchiveConfirmOpen(true)
            },
          }],
          kind: 'menu',
          label: 'More document actions',
          priority: 10,
          title: 'More document actions',
        } satisfies PageHeaderAction]
      : []),
    ...(canWrite && page.status !== 'published'
      ? [{
          disabled: publishPending,
          id: 'publish',
          label: 'Publish',
          onSelect: onPublish,
          primary: true,
          priority: 100,
        } satisfies PageHeaderAction]
      : []),
  ]

  return (
    <KnowledgePane
      actions={headerActions}
      onBack={onBack}
      title={page.title}
    >
      <div className="kb-reader mx-auto my-8 w-full max-w-3xl rounded-xl px-8 py-8 shadow-sm">
        <nav aria-label="Page breadcrumbs" className="mb-5 flex flex-wrap items-center gap-1 text-xs text-[color:var(--tx3)]">
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
        <h1 className="mt-3 text-3xl font-semibold text-[var(--tx)]">{page.title}</h1>
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

        <AttachmentsDrawer
          canWrite={canWrite}
          inline
          onClose={() => undefined}
          open
          pageId={page.id}
        />

        <BacklinksPanel pageId={page.id} />

        <CommentsSection canResolve={canWrite} composerRef={commentsComposerRef} pageId={page.id} />
      </div>
      <ConfirmDialog
        body={
          <>
            <p>The document will be removed from this space. Its version history is retained.</p>
            {archiveError ? (
              <p className="mt-2 text-[color:var(--danger-text)]" role="alert">{archiveError}</p>
            ) : null}
          </>
        }
        confirmLabel={archivePending ? 'Archiving…' : 'Archive document'}
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
              setArchiveError(toFormErrors(error).formError ?? 'Unable to archive this document.')
            })
        }}
        open={archiveConfirmOpen}
        pending={archivePending}
        title={`Archive “${page.title}”?`}
      />
    </KnowledgePane>
  )
}
