import { useId, useRef, useState } from 'react'
import { faFaceSmile } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import { Popover } from '../../overlays/Popover'
import { EmojiPickerPanel } from '../../shared/EmojiPickerPanel'
import { toolbarButtonClass } from './channel-helpers'

// Composer emoji picker: the same panel the message reactions use, opened as a
// Popover above the toolbar and inserting the picked glyph into the input.
export const ComposerEmojiButton = ({ onSelect }: { onSelect: (emoji: string) => void }) => {
  const phoneLayout = usePhoneLayout()
  const pickerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  return (
    <div className="admin-compose-emoji">
      <button
        aria-controls={open ? pickerId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Insert emoji"
        className={toolbarButtonClass}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title="Insert emoji"
        type="button"
      >
        <FontAwesomeIcon className="admin-compose-action-icon h-4 w-4" icon={faFaceSmile} />
      </button>
      <Popover
        anchorRef={triggerRef}
        className="admin-compose-emoji-menu"
        id={pickerId}
        label="Insert emoji"
        onClose={() => setOpen(false)}
        open={open}
        placement="top-start"
      >
        <EmojiPickerPanel
          autoFocusSearch={!phoneLayout}
          onSelect={(emoji) => {
            onSelect(emoji)
            setOpen(false)
          }}
        />
      </Popover>
    </div>
  )
}
