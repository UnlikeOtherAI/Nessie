import { faDownload, faPaperclip } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import {
  downloadAuthedPath,
  useAuthedObjectUrlFromPath,
  useAuthedTextFromPath,
} from '../../../lib/uploads'
import { versionDownloadPath } from '../../../facades/knowledge/file-hooks'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { MessageMarkdown } from '../channels/MessageMarkdown'
import { CommentsSection } from './comments/CommentsSection'
import {
  iconForFilename,
  isMarkdownFilename,
  isZipFilename,
  previewKindForFilename,
} from './file-icons'
import { KnowledgePane } from './KnowledgePane'
import { ZipContents } from './ZipContents'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

type FileNodeViewerProps = {
  canWrite: boolean
  page: KnowledgePageRecord
  // On a phone the workspace owns the doorway through the local-back
  // registry and passes no onBack; wider layouts keep the pane's own Back.
  onBack?: () => void
  onOpenHistory: () => void
  onUploadVersion: () => void
  onToggleAttachments: () => void
}

export const FileNodeViewer = ({
  canWrite,
  page,
  onBack,
  onOpenHistory,
  onUploadVersion,
  onToggleAttachments,
}: FileNodeViewerProps) => {
  const { token } = useAuthSession()
  const version = page.latestVersion
  const previewKind = previewKindForFilename(page.title)
  // A `.md` file node is a document that happens to be stored as a file — a
  // streamed document saves exactly this way — so it renders as markdown
  // through the message renderer (not TipTap, which owns *editing* documents).
  // Remote images are never fetched: the bytes may be model-authored.
  const markdownPreview = previewKind === 'text' && isMarkdownFilename(page.title)
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
  const textPreview = useAuthedTextFromPath(
    previewKind === 'text' && downloadPath ? downloadPath : null,
    token,
  )
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
      ? [{
          id: 'upload-version',
          label: 'Upload new version',
          onSelect: onUploadVersion,
          priority: 40,
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
      onBack={onBack}
      title={page.title}
    >
      <div className="mx-auto my-8 w-full max-w-4xl px-4">
        <div className="flex items-center gap-3 border-b border-[color:var(--sep)] pb-4">
          <FontAwesomeIcon
            className="h-7 w-7 text-[color:var(--tx2)]"
            fixedWidth
            icon={iconForFilename(page.title)}
          />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold text-[var(--tx)]">{page.title}</h1>
            {version ? (
              <p className="text-xs text-[color:var(--tx3)]">Version {version.versionNumber}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-6">
          {!version?.attachmentId ? (
            <p className="text-sm text-[color:var(--tx3)]">This file has no content yet.</p>
          ) : previewKind === 'image' && previewUrl ? (
            <img
              alt={page.title}
              className="mx-auto max-h-[70vh] rounded-lg border border-[color:var(--sep)] object-contain"
              src={previewUrl}
            />
          ) : previewKind === 'pdf' && previewUrl ? (
            <iframe
              className="h-[70vh] w-full rounded-lg border border-[color:var(--sep)] bg-white"
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
              className="mx-auto max-h-[70vh] w-full rounded-lg border border-[color:var(--sep)] bg-black"
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
          ) : markdownPreview ? (
            textPreview.loading ? (
              <p className="py-12 text-center text-sm text-[color:var(--tx3)]">Loading preview…</p>
            ) : textPreview.error || textPreview.text === null ? (
              <p className="py-12 text-center text-sm text-[color:var(--tx3)]">Preview unavailable.</p>
            ) : (
              <div
                className="max-h-[70vh] overflow-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--sb)] p-4"
                data-testid="markdown-file-preview"
              >
                <MessageMarkdown allowRemoteImages={false} renderInlineText={(text) => text}>
                  {textPreview.text}
                </MessageMarkdown>
                {textPreview.truncated ? (
                  <p className="mt-3 text-xs text-[color:var(--tx3)]">
                    …truncated — download to see the rest.
                  </p>
                ) : null}
              </div>
            )
          ) : previewKind === 'text' ? (
            textPreview.loading ? (
              <p className="py-12 text-center text-sm text-[color:var(--tx3)]">Loading preview…</p>
            ) : textPreview.error || textPreview.text === null ? (
              <p className="py-12 text-center text-sm text-[color:var(--tx3)]">Preview unavailable.</p>
            ) : (
              <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[color:var(--sep)] bg-[color:var(--sb)] p-4 font-mono text-xs leading-relaxed text-[color:var(--tx)]">
                {textPreview.text}
                {textPreview.truncated ? '\n\n…truncated — download to see the rest.' : ''}
              </pre>
            )
          ) : isZipFilename(page.title) && version ? (
            <ZipContents pageId={page.id} versionId={version.id} />
          ) : (previewKind === 'image' ||
              previewKind === 'pdf' ||
              previewKind === 'video' ||
              previewKind === 'audio') &&
            !previewUrl ? (
            <p className="py-12 text-center text-sm text-[color:var(--tx3)]">Loading preview…</p>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[color:var(--sep)] py-16 text-center">
              <FontAwesomeIcon
                className="h-10 w-10 text-[color:var(--tx3)]"
                icon={iconForFilename(page.title)}
              />
              <p className="text-sm text-[color:var(--tx3)]">
                No inline preview for this file type.
              </p>
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={() => downloadPath && void downloadAuthedPath(downloadPath, page.title, token)}
                type="button"
              >
                Download to view
              </button>
            </div>
          )}
        </div>

        <CommentsSection canWrite={canWrite} pageId={page.id} />
      </div>
    </KnowledgePane>
  )
}
