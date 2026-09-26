import { lazy, Suspense, useState } from 'react'
import { getCookie } from '../../../lib/storage'
import { useTabParam } from '../../../navigation/useTabParam'
import { useUploadFileVersion } from '../../../facades/knowledge/file-hooks'
import { useConvertToSpreadsheet } from '../../../facades/knowledge/spreadsheet-hooks'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import type { UploadProgress } from '../../../lib/upload-xhr'
import { FileNodeViewer } from './FileNodeViewer'
import { FileVersionUploadDialog } from './FileVersionUploadDialog'
import { useKnowledge } from './KnowledgeProvider'
import { PagePreview } from './PagePreview'
import { FINDER_VIEW_COOKIE, FINDER_VIEWS, migrateStoredFinderView } from './finder/finder-view'

// The whole IronCalc surface — the widget JS, its 72 kB stylesheet and the
// 1.9 MB wasm — sits behind this one dynamic import. Nothing is fetched while a
// person browses `/knowledge-base`; the chunk arrives the first time a
// spreadsheet page opens, and is cached from then on.
// `LiveSpreadsheetPane` is `SpreadsheetPane` with the live lane wired into its
// seams — the ordering rules, presence and the touch overlay (Phase 3b). It is
// the chunk's entry point rather than a second import, so the boundary this
// comment is about is still exactly one dynamic import.
const SpreadsheetPane = lazy(() => import('./spreadsheet/live/LiveSpreadsheetPane'))

type KnowledgeDocumentPaneProps = {
  // The on-demand full-body fetch, handed on so the preview can render the
  // kit's loading / error / retry line for it.
  bodyQuery: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  breadcrumbPages: KnowledgePageRecord[]
  canWrite: boolean
  // The on-demand full body, once it has arrived.
  fullPage?: KnowledgePageRecord
  onBack?: () => void
  page: KnowledgePageRecord
  selectedSpaceId?: string
  spaceName: string
}

// The open document or file node, with everything filed against it: inline
// attachments for readable documents/files and a new version for file nodes.
export const KnowledgeDocumentPane = ({
  bodyQuery,
  breadcrumbPages,
  canWrite,
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
    openEdit,
    openHistory,
    openPagePath,
    publishPage,
    publishPending,
  } = useKnowledge()
  const [versionDialogOpen, setVersionDialogOpen] = useState(false)
  const [versionProgress, setVersionProgress] = useState<UploadProgress | null>(null)
  const [versionError, setVersionError] = useState<string | null>(null)
  // Tree keeps the hierarchy beside the detail, so an extra Back button in
  // the detail header would duplicate the navigation already on screen.
  const [storedView] = useState(() => migrateStoredFinderView(getCookie(FINDER_VIEW_COOKIE)))
  const [view] = useTabParam('view', FINDER_VIEWS, storedView)
  const detailBack = view === 'tree' ? undefined : onBack

  const convertToSpreadsheet = useConvertToSpreadsheet(selectedSpaceId)
  const fileVersionUpload = useUploadFileVersion(page.id, selectedSpaceId)

  return (
    <div className="relative h-full w-full">
      {page.kind === 'spreadsheet' ? (
        <Suspense
          fallback={
            <div
              className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]"
              data-testid="spreadsheet-chunk-loading"
            >
              Opening {page.title}…
            </div>
          }
        >
          <SpreadsheetPane canWrite={canWrite} onBack={detailBack} page={page} />
        </Suspense>
      ) : page.kind === 'file' ? (
        <FileNodeViewer
          canWrite={canWrite}
          onBack={detailBack}
          onOpenAsSpreadsheet={() =>
            convertToSpreadsheet.mutate(page.id, {
              onSuccess: (result) => openPagePath([result.page.id]),
            })}
          onOpenHistory={() => openHistory(page.id)}
          onSaveMarkdown={async (markdown, baseVersionId) => {
            await fileVersionUpload.mutateAsync({
              baseVersionId,
              file: new File([markdown], page.title, { type: 'text/markdown' }),
            })
          }}
          onUploadVersion={() => setVersionDialogOpen(true)}
          page={page}
        />
      ) : (
        <PagePreview
          archivePending={archivePending}
          bodyQuery={bodyQuery}
          breadcrumbPages={breadcrumbPages}
          canWrite={canWrite}
          onBack={detailBack}
          onArchive={() => archivePage(page.id)}
          onBrowseRoot={() => browseTo([])}
          onEdit={() => openEdit(page)}
          onOpenHistory={() => openHistory(page.id)}
          onOpenBreadcrumb={(pageId) => {
            const index = breadcrumbPages.findIndex((breadcrumb) => breadcrumb.id === pageId)
            if (index >= 0) openPagePath(breadcrumbPages.slice(0, index + 1).map((item) => item.id))
          }}
          onPublish={() => publishPage(page.id)}
          page={fullPage ?? page}
          publishPending={publishPending}
          spaceName={spaceName}
        />
      )}
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
