import { useEffect, useRef, useState } from 'react'
import { faBoxArchive, faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useArchiveDoneTasks } from '../../facades/tasks/hooks'

// Top-right action on the Done column: tuck completed work into the Archived
// section without cancelling it (sets archivedAt in this project only).
export const ArchiveDoneMenu = ({ projectId }: { projectId: string }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const archive = useArchiveDoneTasks()

  useEffect(() => {
    if (!open) return
    const onClickAway = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  const run = (olderThanDays?: number) => {
    archive.mutate({ projectId, olderThanDays: olderThanDays ?? null })
    setOpen(false)
  }

  const item =
    'block w-full px-3 py-1.5 text-left text-xs text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]'

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)] disabled:opacity-50"
        disabled={archive.isPending}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <FontAwesomeIcon className="text-[10px]" icon={faBoxArchive} />
        Archive
        <FontAwesomeIcon className="text-[8px]" icon={faChevronDown} />
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-52 overflow-hidden rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] py-1 shadow-lg">
          <button className={item} onClick={() => run()} type="button">
            Archive all done
          </button>
          <button className={item} onClick={() => run(7)} type="button">
            Archive older than a week
          </button>
        </div>
      ) : null}
    </div>
  )
}
