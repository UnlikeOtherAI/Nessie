import { faDownload, faPaperclip } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { downloadAuthedPath, useAuthedObjectUrlFromPath } from '../../../lib/uploads'
import { versionDownloadPath } from '../../../facades/knowledge/file-hooks'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { iconForFilename, previewKindForFilename } from './file-icons'
import { KnowledgePane } from './KnowledgePane'

type FileNodeViewerProps = {
  page: KnowledgePageRecord
  onBack: () => void
  onOpenHistory: () => void
  onUploadVersion: () => void
  onToggleAttachments: () => void
}

export const FileNodeViewer = ({
  page,
  onBack,
  onOpenHistory,
  onUploadVersion,
  onToggleAttachments,
}: FileNodeViewerProps) => {
  const { token } = useAuthSession()
  const version = page.latestVersion
  const previewKind = previewKindForFilename(page.title)
  const downloadPath = version ? versionDownloadPath(page.id, version.id) : null
  // Only fetch bytes for previewable types; binaries stay download-only.
  const previewUrl = useAuthedObjectUrlFromPath(
    previewKind && downloadPath ? downloadPath : null,
    token,
  )

  return (
    <KnowledgePane
      actions={
        <>
          <button
            className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
            onClick={onToggleAttachments}
            type="button"
          >
            <FontAwesomeIcon className="mr-1.5 h-3 w-3" icon={faPaperclip} />
            Attachments
          </button>
          <button
            className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
            onClick={onOpenHistory}
            type="button"
          >
            History
          </button>
          <button
            className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
            onClick={onUploadVersion}
            type="button"
          >
            Upload new version
          </button>
          <button
            className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs"
            disabled={!downloadPath}
            onClick={() => downloadPath && void downloadAuthedPath(downloadPath, page.title, token)}
            type="button"
          >
            <FontAwesomeIcon className="mr-1.5 h-3 w-3" icon={faDownload} />
            Download
          </button>
        </>
      }
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
          ) : (previewKind === 'pdf' || previewKind === 'text') && previewUrl ? (
            <iframe
              className="h-[70vh] w-full rounded-lg border border-[color:var(--sep)] bg-white"
              // The preview blob inherits the admin origin, so a text/HTML file
              // could run scripts in this session. Sandbox text previews (no
              // allow-scripts / allow-same-origin); PDFs keep the native viewer.
              sandbox={previewKind === 'text' ? '' : undefined}
              src={previewUrl}
              title={page.title}
            />
          ) : previewKind && !previewUrl ? (
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
                className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
                onClick={() => downloadPath && void downloadAuthedPath(downloadPath, page.title, token)}
                type="button"
              >
                Download to view
              </button>
            </div>
          )}
        </div>
      </div>
    </KnowledgePane>
  )
}
