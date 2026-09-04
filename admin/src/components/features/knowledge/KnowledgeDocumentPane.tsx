import { useState } from 'react'
import { useUploadFileVersion, useUploadPageAttachment } from '../../../facades/knowledge/file-hooks'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { firstFileOnly, useFileDrop } from '../../../hooks/useFileDrop'
import type { UploadProgress } from '../../../lib/upload-xhr'
import { DropZoneOverlay } from '../../shared/DropZoneOverlay'
import { AttachmentsDrawer } from './AttachmentsDrawer'
import { FileNodeViewer } from './FileNodeViewer'
import { FileVersionUploadDialog } from './FileVersionUploadDialog'
import { useKnowledge } from './KnowledgeProvider'
import { KnowledgePane } from './KnowledgePane'
import { PagePreview } from './PagePreview'

type KnowledgeDocumentPaneProps = {
  // The on-demand full-body fetch, handed on so the preview can render the
  // kit's loading / error / retry line for it.
  bodyQuery: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  breadcrumbPages: KnowledgePageRecord[]
  canWrite: boolean
  // A markdown file node being converted into a real document: the pane says
  // so rather than briefly rendering the raw file.
  converting: boolean
  // The open page's position in the browse path — what "Back to parent page"
  // pops to, and where a drilled child is appended.
  depth: number
  // The on-demand full body, once it has arrived.
  fullPage?: KnowledgePageRecord
  onBack?: () => void
  page: KnowledgePageRecord
  selectedSpaceId?: string
  spaceName: string
}

// The open document or file node, with everything filed against it: its
// attachments drawer, a new file version, and drag-and-drop onto the page.
export const KnowledgeDocumentPane = ({
  bodyQuery,
  breadcrumbPages,
  canWrite,
  converting,
  depth,
  fullPage,
  onBack,
  page,
  selectedSpaceId,
  spaceName,
}: KnowledgeDocumentPaneProps) => {
  const {
    archivePage,
    archivePending,
    browseTo,
    childrenOf,
    drillTo,
    openCreate,
    openEdit,
    openHistory,
    openPagePath,
    publishPage,
    publishPending,
  } = useKnowledge()
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [versionDialogOpen, setVersionDialogOpen] = useState(false)
  const [attachProgress, setAttachProgress] = useState<UploadProgress | null>(null)
  const [versionProgress, setVersionProgress] = useState<UploadProgress | null>(null)
  const [versionError, setVersionError] = useState<string | null>(null)

  const pageAttachmentUpload = useUploadPageAttachment(page.id)
  const fileVersionUpload = useUploadFileVersion(
    versionDialogOpen ? page.id : undefined,
    selectedSpaceId,
  )

  const uploadAttachment = (file: File) => {
    setAttachmentsOpen(true)
    setAttachProgress({ loaded: 0, total: file.size, pct: 0 })
    pageAttachmentUpload.mutate(
      { file, onProgress: setAttachProgress },
      { onSettled: () => setAttachProgress(null) },
    )
  }
  const attachmentDrop = useFileDrop(firstFileOnly(uploadAttachment), !canWrite)

  return (
    <div className="relative h-full w-full" {...attachmentDrop.dropHandlers}>
      {converting ? (
        <KnowledgePane onBack={onBack} title={page.title}>
          <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
            Opening as document…
          </div>
        </KnowledgePane>
      ) : page.kind === 'file' ? (
        <FileNodeViewer
          canWrite={canWrite}
          onBack={onBack}
          onOpenHistory={() => openHistory(page.id)}
          onToggleAttachments={() => setAttachmentsOpen(true)}
          onUploadVersion={() => setVersionDialogOpen(true)}
          page={page}
        />
      ) : (
        <PagePreview
          archivePending={archivePending}
          bodyQuery={bodyQuery}
          breadcrumbPages={breadcrumbPages}
          canWrite={canWrite}
          onBack={onBack}
          onArchive={() => archivePage(page.id)}
          onBrowseRoot={() => browseTo([])}
          onCreateChild={() => openCreate(page.id)}
          onDrill={(childPageId) => drillTo(depth, childPageId)}
          onEdit={() => openEdit(page)}
          onOpenHistory={() => openHistory(page.id)}
          onOpenBreadcrumb={(pageId) => {
            const index = breadcrumbPages.findIndex((breadcrumb) => breadcrumb.id === pageId)
            if (index >= 0) openPagePath(breadcrumbPages.slice(0, index + 1).map((item) => item.id))
          }}
          onPublish={() => publishPage(page.id)}
          onToggleAttachments={() => setAttachmentsOpen(true)}
          page={fullPage ?? page}
          publishPending={publishPending}
          subPages={childrenOf(page.id)}
          spaceName={spaceName}
        />
      )}
      <DropZoneOverlay
        active={attachmentDrop.isDragging}
        label="Drop to attach to this page"
        progressPct={attachProgress?.pct}
        uploading={pageAttachmentUpload.isPending}
      />
      {attachmentsOpen ? (
        <AttachmentsDrawer
          canWrite={canWrite}
          onClose={() => setAttachmentsOpen(false)}
          open={attachmentsOpen}
          pageId={page.id}
        />
      ) : null}
      {versionDialogOpen && canWrite ? (
        <FileVersionUploadDialog
          error={versionError}
          onClose={() => {
            setVersionDialogOpen(false)
            setVersionError(null)
          }}
          onPick={(file) => {
            setVersionError(null)
            setVersionProgress({ loaded: 0, total: file.size, pct: 0 })
            fileVersionUpload.mutate(
              { file, onProgress: setVersionProgress },
              {
                onError: (error) => setVersionError((error as Error).message),
                onSuccess: () => setVersionDialogOpen(false),
                onSettled: () => setVersionProgress(null),
              },
            )
          }}
          progressPct={versionProgress?.pct ?? 0}
          title={page.title}
          uploading={fileVersionUpload.isPending}
        />
      ) : null}
    </div>
  )
}
