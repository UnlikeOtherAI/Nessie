import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import {
  spreadsheetIsFilled,
  useConvertToSpreadsheet,
  useCreateSpreadsheet,
  useImportSpreadsheet,
  useSpreadsheetBootstrap,
} from '../../../../facades/knowledge/spreadsheet-hooks'
import { useToasts } from '../../../../providers/ToastProvider'
import { LEGACY_XLS_REASON, spreadsheetSourceFor } from '../../../shared/file-icons'
import type { UploadProgress } from '../../../../lib/upload-xhr'
import { SpreadsheetCreateDialog } from '../spreadsheet/SpreadsheetCreateDialog'
import {
  SpreadsheetImportDialog,
  type SpreadsheetImportWarningList,
} from '../spreadsheet/SpreadsheetImportDialog'

/**
 * The Finder's three spreadsheet doorways, and the two dialogs they open.
 *
 * `DocumentsFinder` mounts this once and hands the openers to the toolbar's
 * New menu, to a folder column's background menu (both through
 * `new-file-types.ts`) and to a file row's "Open as spreadsheet". They are
 * gathered here rather than inlined because all three end the same way — a
 * page created in a known folder, which then has to be *opened* — and that
 * ending is the part that goes wrong when it is written three times.
 *
 * **Where the page lands.** Every doorway takes the folder it was invoked in,
 * and the path the new page opens at is that folder's own ancestor chain,
 * walked from the loaded page tree rather than borrowed from wherever the
 * browser happens to be standing: a create from a folder column's background
 * menu can name a folder that is not the deepest open one.
 *
 * Nothing here imports the spreadsheet pane. Both dialogs are plain forms, so
 * mounting them costs no part of the IronCalc chunk — that still arrives only
 * when a spreadsheet page actually opens (`KnowledgeDocumentPane`).
 */

type UseFinderSpreadsheetsInput = {
  openPagePath: (path: string[]) => void
  pageById: (pageId: string) => KnowledgePageRecord | undefined
  /** The open folder chain; the fallback when a parent is not loaded. */
  pagePath: string[]
  spaceId?: string
}

export type FinderSpreadsheets = {
  /** "New spreadsheet" in `parentPageId`; `null` is the space's own root. */
  openCreate: (parentPageId: string | null) => void
  /** "Import spreadsheet…" into `parentPageId`. */
  openImport: (parentPageId: string | null) => void
  /** "Open as spreadsheet" on an uploaded `.xlsx`/`.csv`/`.tsv` file node. */
  convert: (page: KnowledgePageRecord) => void
  dialogs: ReactNode
}

export const useFinderSpreadsheets = ({
  openPagePath,
  pageById,
  pagePath,
  spaceId,
}: UseFinderSpreadsheetsInput): FinderSpreadsheets => {
  // `undefined` is closed; `null` is open on the space's root folder — which
  // is why this is not a boolean beside a parent id that can disagree with it.
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined)
  const [importingIn, setImportingIn] = useState<string | null | undefined>(undefined)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [warnings, setWarnings] = useState<SpreadsheetImportWarningList>()
  // One per dialog: a refusal from an import the person has closed must not
  // reappear under the title field of a create they open afterwards.
  const [createError, setCreateError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // A page the worker is still filling, and where it will be opened once it
  // is. Import and convert both answer `202`, and opening the page before the
  // workbook lands strands the reader on a grid that never fills: the pane
  // bootstraps from an empty head and nothing tells it otherwise.
  const [filling, setFilling] = useState<{ parentPageId: string | null; pageId: string } | null>(
    null,
  )
  const fillingBootstrap = useSpreadsheetBootstrap(filling?.pageId, { untilFilled: true })
  // The same poll for the import dialog, which keeps its own button rather
  // than opening on its own.
  const [importedPageId, setImportedPageId] = useState<string | null>(null)
  const importedBootstrap = useSpreadsheetBootstrap(importedPageId ?? undefined, {
    untilFilled: true,
  })
  const { pushToast } = useToasts()

  const create = useCreateSpreadsheet(spaceId)
  const importSpreadsheet = useImportSpreadsheet(spaceId)
  const convertToSpreadsheet = useConvertToSpreadsheet(spaceId)

  /**
   * A folder's ancestor chain, deepest last, from the loaded page tree. A
   * folder whose parents are not loaded (a cold deep link) falls back to the
   * open path, which is the only other honest answer the client has.
   */
  const pathTo = useCallback((parentPageId: string | null): string[] => {
    if (parentPageId === null) return []
    const chain: string[] = []
    const seen = new Set<string>()
    let current = pageById(parentPageId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      chain.unshift(current.id)
      current = current.parentPageId ? pageById(current.parentPageId) : undefined
    }
    return chain.length > 0 ? chain : pagePath
  }, [pageById, pagePath])

  const openCreated = useCallback((parentPageId: string | null, pageId: string) => {
    openPagePath([...pathTo(parentPageId), pageId])
  }, [openPagePath, pathTo])

  // The one place a filled page is opened. The poll has already put the real
  // bootstrap in the cache under the pane's own key, so the pane mounts on the
  // workbook rather than fetching an empty one again.
  useEffect(() => {
    if (!filling || !spreadsheetIsFilled(fillingBootstrap.data)) return
    openPagePath([...pathTo(filling.parentPageId), filling.pageId])
    setFilling(null)
  }, [filling, fillingBootstrap.data, openPagePath, pathTo])

  const closeImport = useCallback(() => {
    setImportingIn(undefined)
    setWarnings(undefined)
    setImportedPageId(null)
    setImportError(null)
    setProgress(null)
  }, [])

  const convert = useCallback((page: KnowledgePageRecord) => {
    // The disabled menu row already says why an `.xls` cannot; this guard is
    // here because the same action hangs off the file pane's own header too.
    if (spreadsheetSourceFor(page.title) !== 'convertible') return
    // The page opens a second or two later, once the worker has read the file,
    // so the click is acknowledged rather than looking like it missed. Worded
    // as what was asked for, not as progress: a toast lives seven seconds, and
    // "Reading the file…" is a lie for most of them.
    pushToast({ body: '', title: `Building a spreadsheet from “${page.title}”` })
    convertToSpreadsheet.mutate(page.id, {
      onError: (failure) => pushToast({
        body: (failure as Error).message,
        title: 'Couldn’t open that as a spreadsheet',
      }),
      onSuccess: (result) =>
        setFilling({ pageId: result.page.id, parentPageId: page.parentPageId ?? null }),
    })
  }, [convertToSpreadsheet, pushToast])

  const dialogs = (
    <>
      {creatingIn !== undefined ? (
        <SpreadsheetCreateDialog
          error={createError}
          onClose={() => {
            setCreatingIn(undefined)
            setCreateError(null)
          }}
          onSubmit={(title) => {
            const parentPageId = creatingIn
            setCreateError(null)
            create.mutate(
              { parentPageId, title },
              {
                // A refused create used to leave the dialog open and silent.
                onError: (failure) => setCreateError((failure as Error).message),
                onSuccess: (created) => {
                  setCreatingIn(undefined)
                  openCreated(parentPageId, created.id)
                },
              },
            )
          }}
          open
          pending={create.isPending}
        />
      ) : null}
      {importingIn !== undefined ? (
        <SpreadsheetImportDialog
          error={importError}
          onClose={closeImport}
          // Offered only once the worker has actually put the workbook in the
          // page: "Open spreadsheet" landing on an empty grid is worse than
          // waiting a second for it.
          importing={Boolean(importedPageId) && !spreadsheetIsFilled(importedBootstrap.data)}
          onOpenImported={importedPageId && spreadsheetIsFilled(importedBootstrap.data)
            ? () => {
              const pageId = importedPageId
              const parentPageId = importingIn
              closeImport()
              openCreated(parentPageId, pageId)
            }
            : undefined}
          onPick={(file) => {
            // Refused here rather than at the server: once the bytes are up,
            // an `.xls` and a corrupt zip fail identically, and the answer
            // would read as a broken file rather than a format we cannot open.
            if (spreadsheetSourceFor(file.name) === 'legacy-xls') {
              setImportError(LEGACY_XLS_REASON)
              return
            }
            setImportError(null)
            setProgress({ loaded: 0, pct: 0, total: file.size })
            importSpreadsheet.mutate(
              { file, onProgress: setProgress, parentPageId: importingIn ?? undefined },
              {
                onError: (failure) => setImportError((failure as Error).message),
                onSettled: () => setProgress(null),
                onSuccess: (result) => {
                  setWarnings(result.warnings)
                  setImportedPageId(result.page.id)
                },
              },
            )
          }}
          progressPct={progress?.pct ?? 0}
          uploading={importSpreadsheet.isPending}
          warnings={warnings}
        />
      ) : null}
    </>
  )

  return {
    convert,
    dialogs,
    openCreate: setCreatingIn,
    openImport: setImportingIn,
  }
}
