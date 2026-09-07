import { useRef, useState } from 'react'
import { faBoxArchive, faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useArchiveDoneTasks } from '../../../../facades/tasks/hooks'
import { Popover } from '../../../overlays/Popover'

// Top-right action on the Done column: tuck completed work into the Archived
// section without cancelling it (sets archivedAt). Scoped to the board it sits
// on — a board owns its tickets, so a click here must not reach the completed
// work of a sibling board.
export const ArchiveDoneMenu = ({
  boardId,
  projectId,
}: {
  boardId: string
  projectId: string
}) => {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const archive = useArchiveDoneTasks()

  const run = (olderThanDays?: number) => {
    archive.mutate({ boardId, projectId, olderThanDays: olderThanDays ?? null })
    setOpen(false)
  }

  const menuId = `archive-done-${boardId}`
  const item =
    'flex min-h-11 w-full items-center rounded-md px-2.5 text-left text-xs text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]'

  return (
    <>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        className="admin-button admin-button-secondary h-11 gap-1.5"
        disabled={archive.isPending}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <FontAwesomeIcon className="h-3 w-3" icon={faBoxArchive} />
        Archive
        <FontAwesomeIcon className="h-2.5 w-2.5" icon={faChevronDown} />
      </button>
      <Popover
        anchorRef={triggerRef}
        className="w-52 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-1 shadow-lg"
        id={menuId}
        label="Archive completed tasks"
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-end"
      >
        <button className={item} onClick={() => run()} type="button">
          Archive all done
        </button>
        <button className={item} onClick={() => run(7)} type="button">
          Archive older than a week
        </button>
      </Popover>
    </>
  )
}
