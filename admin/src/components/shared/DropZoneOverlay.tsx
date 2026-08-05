import { faCloudArrowUp } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

// Full-cover overlay shown while a file is dragged over (or uploading to) a drop
// host. The host must be `position: relative`. Renders a darkened backdrop with
// a centered square dashed drop target; during upload it shows live progress.
export const DropZoneOverlay = ({
  active,
  uploading,
  progressPct,
  label = 'Drop the file here',
}: {
  active: boolean
  uploading?: boolean
  progressPct?: number
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
          <span className="text-sm font-medium text-[color:var(--tx)]">{label}</span>
        )}
      </div>
    </div>
  )
}
