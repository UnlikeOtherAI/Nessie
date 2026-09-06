import { useId, useRef, useState } from 'react'
import { faFaceSmile } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Popover } from '../overlays/Popover'
import { EmojiPickerPanel } from './EmojiPickerPanel'

/**
 * Trigger + anchored emoji picker for a reaction row (message actions, comment
 * actions). Was two near-identical hand-rolled `role="dialog"` menus; this is
 * the one `Popover`-based version (docs/navigation/overview.md §7).
 *
 * The trigger commonly sits in a hover-revealed action row (opacity/visibility
 * gated by the row's own `:hover` CSS). `Popover` portals its panel to the
 * overlay host, outside that row's DOM subtree, so the open picker keeps
 * rendering and stays interactive after the pointer leaves the row.
 */

type EmojiReactionButtonProps = {
  className?: string
  onSelect: (emoji: string) => void
  title?: string
}

export const EmojiReactionButton = ({
  className = 'admin-msg-action-button',
  onSelect,
  title = 'Add emoji reaction',
}: EmojiReactionButtonProps) => {
  const pickerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const pick = (emoji: string) => {
    onSelect(emoji)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        aria-controls={open ? pickerId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Add emoji reaction"
        className={className}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title={title}
        type="button"
      >
        <FontAwesomeIcon icon={faFaceSmile} />
      </button>
      <Popover
        anchorRef={triggerRef}
        className="admin-msg-emoji-menu"
        id={pickerId}
        label={title}
        onClose={() => setOpen(false)}
        open={open}
        role="menu"
      >
        <EmojiPickerPanel onSelect={pick} />
      </Popover>
    </div>
  )
}
