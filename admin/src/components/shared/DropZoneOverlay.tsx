import { faCloudArrowUp } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

/**
 * What the overlay says, given what the pointer is carrying and where it would
 * land. A count is only known once the drag is over the host (the items list
 * is readable during a drag; `dataTransfer.files` is not), so every combination
 * has to read as a whole sentence rather than a template with a hole in it.
 *
 * Pure, and exported, because the Finder's column and the toolbar's hidden
 * file input must not drift into two spellings of the same sentence.
 */
export const dropZoneLabel = ({
  count = 0,
  destination,
}: {
  count?: number | null
  destination?: string | null
}): string => {
  const files = typeof count === 'number' && count > 0 ? count : 0
  const noun = files === 1 ? 'file' : 'files'
  if (destination) {
    return files > 0 ? `Drop ${files} ${noun} into ${destination}` : `Drop to upload into ${destination}`
  }
  return files > 0 ? `Drop ${files} ${noun} here` : 'Drop the file here'
}

// Full-cover overlay shown while a file is dragged over (or uploading to) a drop
// host. The host must be `position: relative`. Renders a darkened backdrop with
// a centered square dashed drop target; during upload it shows live progress.
export const DropZoneOverlay = ({
  active,
  count,
  destination,
  uploading,
  progressPct,
  label,
}: {
  active: boolean
  // How many files the pointer is carrying, when the host knows.
  count?: number | null
  // The folder the drop would land in; names the target in the sentence.
  destination?: string | null
  uploading?: boolean
  progressPct?: number
  // An explicit sentence, for a host whose drop is not "upload into a folder".
  label?: string
}) => {
  if (!active && !uploading) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-[color:var(--scrim-strong)] backdrop-blur-[1px]">
      <div className="flex aspect-square w-56 max-w-[70%] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-[color:var(--accent)] bg-[color:var(--main)]/80 p-6 text-center">
        <FontAwesomeIcon className="h-8 w-8 text-[color:var(--accent)]" icon={faCloudArrowUp} />
        {uploading ? (
          <>
            <span className="text-sm font-medium text-[color:var(--tx)]">
              Uploading… {progressPct ?? 0}%
            </span>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--overlay)]">
              <div
                className="h-full rounded-full bg-[color:var(--accent)] transition-[width] duration-150"
                style={{ width: `${progressPct ?? 0}%` }}
              />
            </div>
          </>
        ) : (
          <span className="text-sm font-medium text-[color:var(--tx)]">
            {label ?? dropZoneLabel({ count, destination })}
          </span>
        )}
      </div>
    </div>
  )
}
