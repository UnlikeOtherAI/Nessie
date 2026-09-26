import { useId, useRef, useState, type ReactNode } from 'react'
import { faFaceSmile } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useTranslation } from 'react-i18next'
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
  icon?: ReactNode
  onSelect: (emoji: string) => void
  title?: string
}

export const EmojiReactionButton = ({
  className = 'admin-msg-action-button',
  icon,
  onSelect,
  title,
}: EmojiReactionButtonProps) => {
  const { t } = useTranslation('common')
  const label = title ?? t('reaction.add')
  const pickerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const pick = (emoji: string) => {
    onSelect(emoji)
    setOpen(false)
  }

  return (
    <div className="relative" data-emoji-picker-open={open}>
      <button
        aria-controls={open ? pickerId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className={className}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title={label}
        type="button"
      >
        {icon ?? <FontAwesomeIcon icon={faFaceSmile} />}
      </button>
      <Popover
        anchorRef={triggerRef}
        className="admin-msg-emoji-menu"
        id={pickerId}
        label={label}
        onClose={() => setOpen(false)}
        open={open}
        role="menu"
      >
        <EmojiPickerPanel onSelect={pick} />
      </Popover>
    </div>
  )
}
