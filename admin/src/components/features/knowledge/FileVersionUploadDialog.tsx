import { useRef, useState } from 'react'
import { faCloudArrowUp } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { firstFileOnly, useFileDrop } from '../../../hooks/useFileDrop'
import { Dialog } from '../../shared/Dialog'

// Modal for uploading a new version of a file node. Its body is a drop zone on
// desktop and a tap-to-open native picker on touch devices. The actual upload
// is performed by the caller via `onPick`, which reports progress back.
export const FileVersionUploadDialog = ({
  title,
  onClose,
  onPick,
  uploading,
  progressPct,
  error,
}: {
  title: string
  onClose: () => void
  onPick: (file: File) => void
  uploading: boolean
  progressPct: number
  error?: string | null
}) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pickedName, setPickedName] = useState<string | null>(null)

  const handleFile = (file: File) => {
    setPickedName(file.name)
    onPick(file)
  }
  const { isDragging, dropHandlers } = useFileDrop(firstFileOnly(handleFile), uploading)

  return (
    <Dialog
      description={title}
      dismissDisabled={uploading}
      onClose={onClose}
      open
      title="Upload a new version"
    >
      <button
        className={[
          'flex aspect-square w-full max-h-64 flex-col items-center justify-center gap-3 rounded-2xl',
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
              Uploading… {progressPct}%
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
              Drop a file here, or tap to choose
            </span>
            {pickedName ? (
              <span className="max-w-full truncate text-xs text-[color:var(--tx3)]">{pickedName}</span>
            ) : null}
          </>
        )}
      </button>

      {error ? <p className="mt-3 text-xs text-[color:var(--danger-text)]">{error}</p> : null}

      <input
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) handleFile(file)
          event.target.value = ''
        }}
        ref={inputRef}
        type="file"
      />
    </Dialog>
  )
}
