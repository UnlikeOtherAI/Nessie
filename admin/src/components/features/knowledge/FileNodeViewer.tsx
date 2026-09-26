import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  faClockRotateLeft,
  faComment,
  faDownload,
  faEllipsis,
  faEye,
  faPaperclip,
  faPen,
  faTable,
  faUpload,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useTabParam } from '../../../navigation/useTabParam'
import { downloadAuthedPath, useAuthedObjectUrlFromPath } from '../../../lib/uploads'
import { usePageAttachments, versionDownloadPath } from '../../../facades/knowledge/file-hooks'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { EmptyState } from '../../shared/EmptyState'
import { RetryableTextFilePreview } from '../../shared/TextFilePreview'
import { MessageMarkdown } from '../channels/MessageMarkdown'
import { CommentsSection } from './comments/CommentsSection'
import {
  isMarkdownFilename,
  isSpreadsheetSourceFilename,
  isZipFilename,
  previewKindForFilename,
} from '../../shared/file-icons'
import { KnowledgePane } from './KnowledgePane'
import { MarkdownFileEditorDialog } from './MarkdownFileEditorDialog'
import { ZipContents } from './ZipContents'
import { AttachmentsDrawer } from './AttachmentsDrawer'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'
import { TabBar, type TabBarItem } from '../../primitives/TabBar'

type FileTab = 'preview' | 'attachments' | 'comments'
const FILE_TABS: ReadonlyArray<TabBarItem<FileTab>> = [
  { icon: <FontAwesomeIcon icon={faEye} />, label: 'Preview', value: 'preview' },
  { icon: <FontAwesomeIcon icon={faPaperclip} />, label: 'Attachments', value: 'attachments' },
  { icon: <FontAwesomeIcon icon={faComment} />, label: 'Comments', value: 'comments' },
]
const FILE_TAB_VALUES: readonly FileTab[] = ['preview', 'attachments', 'comments']
import { taskSetCreatePath, taskSetSourceFormat } from '../../../navigation/task-sets'

// Which filenames can become a workbook is `file-icons.ts`'s answer, because
// the Finder's file-row menu asks the same question and two spellings of it
// would let the header and the menu disagree about one file.
export { isSpreadsheetSourceFilename }

type FileNodeViewerProps = {
  canWrite: boolean
  page: KnowledgePageRecord
  // On a phone the team owns the doorway through the local-back
  // registry and passes no onBack; wider layouts keep the pane's own Back.
  onBack?: () => void
  onOpenHistory: () => void
  /**
   * Builds a spreadsheet document from this file, beside it. The original file
   * node is kept — converting is additive, so a person who wanted the file can
   * still download the bytes they uploaded.
   */
  onOpenAsSpreadsheet?: () => void
  onSaveMarkdown?: (markdown: string, baseVersionId: string) => Promise<void>
  onUploadVersion: () => void
}

export const FileNodeViewer = ({
  canWrite,
  page,
  onBack,
  onOpenAsSpreadsheet,
  onOpenHistory,
  onSaveMarkdown,
  onUploadVersion,
}: FileNodeViewerProps) => {
  const navigate = useNavigate()
  const { token } = useAuthSession()
  const version = page.latestVersion
  const titlePreviewKind = previewKindForFilename(page.title)
  // A verified canonical projection is authoritative even after the display
  // title is renamed to another extension (or has no extension).
  const previewKind = version?.sourceContentHash ? 'text' : titlePreviewKind
  // A `.md` file node is a document that happens to be stored as a file — a
  // streamed document saves exactly this way — so it renders as markdown
  // through the message renderer (not TipTap, which owns *editing* documents).
  // Remote images are never fetched: the bytes may be model-authored.
  const markdownPreview = previewKind === 'text'
    && (Boolean(version?.sourceContentHash) || isMarkdownFilename(page.title))
  const [markdownEditorOpen, setMarkdownEditorOpen] = useState(false)
  const [activeTab, setActiveTab] = useTabParam('detail', FILE_TAB_VALUES, 'preview')
  const { data: attachments = [] } = usePageAttachments(page.id)
  const tabs = useMemo(() => FILE_TABS.map((tab) => tab.value === 'attachments'
    ? { ...tab, count: attachments.length || undefined }
    : tab), [attachments.length])
  const [markdownEditorBaseVersionId, setMarkdownEditorBaseVersionId] = useState<string | null>(null)
  // Pin the PDF preview blob's MIME to application/pdf so a file with an
  // attacker-controlled content-type (e.g. text/html bytes named "x.pdf") can
  // never render as executable HTML in the same-origin iframe. Image previews
  // keep the server type (<img> can't execute scripts); text renders as a <pre>.
  const previewMime = previewKind === 'pdf' ? 'application/pdf' : undefined
  const downloadPath = version ? versionDownloadPath(page.id, version.id) : null
  // Image/PDF preview via an object URL; text/config render as plain text (a
  // <pre>, never an iframe — so the file's bytes can't run scripts). Binaries
  // stay download-only.
  const previewUrl = useAuthedObjectUrlFromPath(
    (previewKind === 'image' ||
      previewKind === 'pdf' ||
      previewKind === 'video' ||
      previewKind === 'audio') &&
      downloadPath
      ? downloadPath
      : null,
    token,
    // Only the PDF iframe needs a pinned MIME; <img>/<video>/<audio> can't execute
    // scripts, so they keep the server's media type for correct codec selection.
    previewMime,
  )
  const headerActions: PageHeaderAction[] = [
    {
      compact: true,
      icon: faClockRotateLeft,
      id: 'history',
      label: 'History',
      onSelect: onOpenHistory,
      priority: 50,
      title: 'Version history',
    },
    ...(canWrite
      ? [{
          compact: true,
          icon: faUpload,
          id: 'upload-version',
          label: 'Upload new version',
          onSelect: onUploadVersion,
          priority: 40,
          title: 'Upload new version',
        } satisfies PageHeaderAction]
      : []),
    ...(canWrite && onOpenAsSpreadsheet && isSpreadsheetSourceFilename(page.title)
      ? [{
          compact: true,
          icon: faTable,
          id: 'convert-to-spreadsheet',
          label: 'Open as spreadsheet',
          onSelect: onOpenAsSpreadsheet,
          priority: 80,
          title: 'Open as spreadsheet',
        } satisfies PageHeaderAction]
      : []),
    ...(canWrite && markdownPreview && downloadPath && onSaveMarkdown
      ? [{
          compact: true,
          icon: faPen,
          id: 'edit-markdown',
          label: 'Edit',
          onSelect: () => {
            if (!version) return
            setMarkdownEditorBaseVersionId(version.id)
            setMarkdownEditorOpen(true)
          },
          priority: 70,
          title: 'Edit text file',
        } satisfies PageHeaderAction]
      : []),
    ...(version && taskSetSourceFormat(page.title)
      ? [{
          compact: true,
          icon: faEllipsis,
          id: 'task-set-actions',
          items: [{
            id: 'process-task-set',
            label: 'Process with Task Set',
            onSelect: () => navigate(taskSetCreatePath({
              pageId: page.id, versionId: version.id, format: taskSetSourceFormat(page.title),
            })),
          }],
          kind: 'menu',
          label: 'More file actions',
          priority: 10,
          title: 'More file actions',
        } satisfies PageHeaderAction]
      : []),
    {
      disabled: !downloadPath,
      icon: faDownload,
      id: 'download',
      label: 'Download',
      onSelect: () => downloadPath && void downloadAuthedPath(downloadPath, page.title, token),
      primary: true,
      priority: 100,
    },
  ]

  return (
    <KnowledgePane
      actions={headerActions}
      below={(
        <TabBar ariaLabel="File sections" idPrefix="knowledge-file" items={tabs} onChange={setActiveTab} value={activeTab} />
      )}
      onBack={onBack}
      title={page.title}
    >
      {activeTab === 'preview' ? (
        <div aria-labelledby="knowledge-file-tab-preview" id="knowledge-file-tabpanel-preview" role="tabpanel" className="mx-auto my-8 w-full max-w-4xl px-4">
        {version ? (
          <p className="mb-4 text-xs text-[color:var(--tx3)]">Version {version.versionNumber}</p>
        ) : null}

        <div className="mt-6">
          {!version?.attachmentId ? (
            <EmptyState>This file has no content yet.</EmptyState>
          ) : previewKind === 'image' && previewUrl ? (
            <img
              alt={page.title}
              className="mx-auto max-h-[70vh] rounded-lg border border-[color:var(--sep)] object-contain"
              src={previewUrl}
            />
          ) : previewKind === 'pdf' && previewUrl ? (
            <iframe
              className="h-[70vh] w-full rounded-lg border border-[color:var(--sep)] bg-[var(--surface-inverse)]"
              // previewUrl's blob MIME is pinned to application/pdf (above), so a
              // file with an attacker-controlled content-type (e.g. text/html
              // named "x.pdf") renders as a failed PDF, never executable HTML.
              // Deliberately NOT sandboxed: any `sandbox` attribute stops
              // Chrome's PDF viewer from loading a blob: URL at all (verified),
              // and the MIME pin already closes the script-execution path.
              src={previewUrl}
              title={page.title}
            />
          ) : previewKind === 'video' && previewUrl ? (
            <video
              className="mx-auto max-h-[70vh] w-full rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-strong)]"
              controls
              src={previewUrl}
            >
              Your browser can’t play this video — use Download.
            </video>
          ) : previewKind === 'audio' && previewUrl ? (
            <div className="rounded-lg border border-[color:var(--sep)] bg-[color:var(--sb)] p-4">
              <audio className="w-full" controls src={previewUrl}>
                Your browser can’t play this audio — use Download.
              </audio>
            </div>
          ) : markdownPreview && downloadPath ? (
            <RetryableTextFilePreview
              downloadPath={downloadPath}
              render={({ text, truncated }) => (
                <div
                  className="max-h-[70vh] overflow-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--sb)] p-4"
                  data-testid="markdown-file-preview"
                >
                  <MessageMarkdown allowRemoteImages={false} renderInlineText={(inline) => inline}>
                    {text}
                  </MessageMarkdown>
                  {truncated ? (
                    <p className="mt-3 text-xs text-[color:var(--tx3)]">
                      …truncated — download to see the rest.
                    </p>
                  ) : null}
                </div>
              )}
              token={token}
            />
          ) : previewKind === 'text' && downloadPath ? (
            <RetryableTextFilePreview
              downloadPath={downloadPath}
              render={({ text, truncated }) => (
                <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[color:var(--sep)] bg-[color:var(--sb)] p-4 font-mono text-xs leading-relaxed text-[color:var(--tx)]">
                  {text}
                  {truncated ? '\n\n…truncated — download to see the rest.' : ''}
                </pre>
              )}
              token={token}
            />
          ) : isZipFilename(page.title) && version ? (
            <ZipContents pageId={page.id} versionId={version.id} />
          ) : (previewKind === 'image' ||
              previewKind === 'pdf' ||
              previewKind === 'video' ||
              previewKind === 'audio') &&
            !previewUrl ? (
            // `useAuthedObjectUrlFromPath` has no error signal distinct from
            // "not ready yet" (both read back as a null url), so this can't
            // offer a Retry without conflating a real failure with a normal
            // in-flight load — see the knowledge content-kit migration report.
            <p className="py-12 text-center text-sm text-[color:var(--tx3)]">Loading preview…</p>
          ) : (
            <EmptyState
              action={
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  onClick={() => downloadPath && void downloadAuthedPath(downloadPath, page.title, token)}
                  type="button"
                >
                  Download to view
                </button>
              }
            >
              No inline preview for this file type.
            </EmptyState>
          )}
        </div>

        </div>
      ) : activeTab === 'attachments' ? (
        <div aria-labelledby="knowledge-file-tab-attachments" id="knowledge-file-tabpanel-attachments" role="tabpanel" className="mx-auto my-8 w-full max-w-4xl px-4">
        <AttachmentsDrawer
          canWrite={canWrite}
          inline
          onClose={() => undefined}
          open
          pageId={page.id}
        />
        </div>
      ) : (
        <div aria-labelledby="knowledge-file-tab-comments" id="knowledge-file-tabpanel-comments" role="tabpanel" className="mx-auto my-8 w-full max-w-4xl px-4">
        <CommentsSection canResolve={canWrite} pageId={page.id} />
        </div>
      )}
      {markdownEditorOpen && markdownEditorBaseVersionId && onSaveMarkdown ? (
        <MarkdownFileEditorDialog
          baseVersionId={markdownEditorBaseVersionId}
          downloadPath={versionDownloadPath(page.id, markdownEditorBaseVersionId)}
          filename={page.title}
          onClose={() => {
            setMarkdownEditorOpen(false)
            setMarkdownEditorBaseVersionId(null)
          }}
          onSave={onSaveMarkdown}
          token={token}
        />
      ) : null}
    </KnowledgePane>
  )
}
