import { useRef, useState } from 'react'
import { faCloudArrowUp } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { firstFileOnly, useFileDrop } from '../../../../hooks/useFileDrop'
import { Dialog } from '../../../shared/Dialog'
import { Notice } from '../../../primitives/Notice'
import type { SpreadsheetImportWarning } from '../../../../facades/knowledge/spreadsheet-hooks'

/**
 * “Import spreadsheet…”. The drop/progress body is `FileVersionUploadDialog`'s,
 * re-expressed here because this dialog has a second act the other one does
 * not: the **warning list**.
 *
 * An import is lossy in ways the engine cannot report (decisions.md §"Spike B"),
 * so the server derives them by scanning the source package, and the dialog
 * stays open to show them rather than dropping the reader into a workbook that
 * quietly lost its charts. Merged cells survive the file but are invisible to
 * this version's API, and an imported autofilter is genuinely lost on the next
 * save — both are things a person must be told once, at import.
 */

export const SPREADSHEET_IMPORT_ACCEPT = '.xlsx,.csv,.tsv'

/** Present once the import came back — an empty list means nothing was lost. */
export type SpreadsheetImportWarningList = SpreadsheetImportWarning[]

export const SpreadsheetImportDialog = ({
  importing = false,
  onClose,
  onOpenImported,
  onPick,
  progressPct,
  uploading,
  error,
  warnings,
}: {
  error?: string | null
  /**
   * The bytes are up and the worker is still reading them. The route answers
   * `202`, so "Imported" is not the same moment as "there is a workbook in
   * there" — and opening the page in between lands on an empty grid that never
   * fills.
   */
  importing?: boolean
  onClose: () => void
  /** Shown once the workbook has actually landed, never on the `202` alone. */
  onOpenImported?: () => void
  onPick: (file: File) => void
  progressPct: number
  uploading: boolean
  warnings?: SpreadsheetImportWarning[]
}) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pickedName, setPickedName] = useState<string | null>(null)

  const handleFile = (file: File) => {
    setPickedName(file.name)
    onPick(file)
  }
  const { dropHandlers, isDragging } = useFileDrop(firstFileOnly(handleFile), uploading)
  const done = Boolean(warnings)

  return (
    <Dialog
      description="An .xlsx, .csv or .tsv file becomes a spreadsheet document here."
      dismissDisabled={uploading}
      onClose={onClose}
      open
      title="Import spreadsheet"
    >
      <div className="grid gap-3" data-testid="spreadsheet-import-dialog">
        {done ? null : (
          <button
            className={[
              'flex aspect-square max-h-64 w-full flex-col items-center justify-center gap-3 rounded-2xl',
              'border-2 border-dashed p-6 text-center transition-colors',
              isDragging
                ? 'border-[color:var(--accent)] bg-[color:var(--overlay)]'
                : 'border-[color:var(--sep)] hover:border-[color:var(--accent)]',
            ].join(' ')}
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            type="button"
            {...dropHandlers}
          >
            <FontAwesomeIcon className="h-8 w-8 text-[color:var(--accent)]" icon={faCloudArrowUp} />
            {uploading ? (
              <>
                <span className="text-sm font-medium text-[color:var(--tx)]">
                  Importing… {progressPct}%
                </span>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--overlay)]">
                  <div
                    className="h-full rounded-full bg-[color:var(--accent)] transition-[width] duration-150"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </>
            ) : (
              <>
                <span className="text-sm font-medium text-[color:var(--tx)]">
                  Drop a spreadsheet here, or tap to choose
                </span>
                {pickedName ? (
                  <span className="max-w-full truncate text-xs text-[color:var(--tx3)]">
                    {pickedName}
                  </span>
                ) : null}
              </>
            )}
          </button>
        )}

        <input
          accept={SPREADSHEET_IMPORT_ACCEPT}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) handleFile(file)
          }}
          ref={inputRef}
          type="file"
        />

        {error ? <p className="text-xs text-[color:var(--danger-text)]">{error}</p> : null}

        {warnings && warnings.length > 0 ? (
          <Notice data-testid="spreadsheet-import-warnings" size="sm" tone="warning">
            <p className="font-semibold">Imported, with some things this version cannot carry:</p>
            <ul className="mt-1 list-disc pl-4">
              {warnings.map((warning) => (
                <li key={`${warning.kind}:${warning.detail}`}>{warning.detail}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {warnings && warnings.length === 0 ? (
          <Notice size="sm" tone="success">Imported with nothing dropped.</Notice>
        ) : null}

        {done ? (
          <div className="flex justify-end gap-2">
            <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
              Close
            </button>
            {importing ? (
              <span
                className="self-center text-xs text-[color:var(--tx3)]"
                data-testid="spreadsheet-import-reading"
              >
                Still reading the file…
              </span>
            ) : null}
            {onOpenImported ? (
              <button
                className="admin-button admin-button-primary"
                data-testid="spreadsheet-import-open"
                onClick={onOpenImported}
                type="button"
              >
                Open spreadsheet
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
