import { useRef, useState } from 'react'
import { faBolt, faEllipsis } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { TicketWorkPickupColumn } from '@nessie/schemas'

import { Popover } from '../../overlays/Popover'

/**
 * A board column that starts an agent's work, said on its header
 * (docs/standards/ticket-work.md → "What the project sees").
 *
 * The badge is read-only and shown to everyone who can see the board: whoever
 * moves a ticket here should know it starts work before they do. The menu's
 * "Start work with an agent…" is offered only to people the Triggers routes
 * would let create a trigger — the server says who that is — and opens the
 * Triggers editor on a ticket trigger for this column.
 */

export const ColumnStartsWorkBadge = ({ pickups }: { pickups: readonly TicketWorkPickupColumn[] }) => {
  if (pickups.length === 0) return null
  const names = [...new Set(pickups.map((pickup) => pickup.agentName))].join(', ')
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 rounded-md bg-[color:var(--overlay)] px-2 py-1 text-[11px] text-[color:var(--tx2)]"
      data-testid="column-starts-work"
      title={`Moving a ticket here starts ${names}'s work on it`}
    >
      <FontAwesomeIcon aria-hidden className="h-2.5 w-2.5 shrink-0 text-[color:var(--info-text)]" icon={faBolt} />
      <span className="truncate">Moving here starts work: {names}</span>
    </div>
  )
}

export const ColumnWorkMenu = ({
  columnId,
  columnName,
  onStartWork,
}: {
  columnId: string
  columnName: string
  onStartWork: () => void
}) => {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = `column-work-${columnId}`
  return (
    <>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-label={`${columnName} column actions`}
        className="flex h-11 w-11 items-center justify-center rounded-md text-[color:var(--tx3)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
        data-testid="column-work-menu"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <FontAwesomeIcon className="h-3.5 w-3.5" icon={faEllipsis} />
      </button>
      <Popover
        anchorRef={triggerRef}
        className="w-60 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-1 shadow-lg"
        id={menuId}
        label={`${columnName} column actions`}
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-end"
        role="menu"
      >
        <button
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]"
          onClick={() => {
            setOpen(false)
            onStartWork()
          }}
          role="menuitem"
          type="button"
        >
          <FontAwesomeIcon className="h-3 w-3" icon={faBolt} />
          Start work with an agent…
        </button>
      </Popover>
    </>
  )
}
