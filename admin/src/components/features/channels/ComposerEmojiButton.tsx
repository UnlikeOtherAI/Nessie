import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { faFaceSmile } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import { EmojiPickerPanel } from '../../shared/EmojiPickerPanel'
import { toolbarButtonClass } from './channel-helpers'

// Composer emoji picker: the same panel the message reactions use, opened as a
// popover above the toolbar and inserting the picked glyph into the input.
// Dismissal mirrors the reaction picker — outside pointerdown or Escape.
export const ComposerEmojiButton = ({ onSelect }: { onSelect: (emoji: string) => void }) => {
  const phoneLayout = usePhoneLayout()
  const pickerId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) {
      return undefined
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="admin-compose-emoji" onKeyDown={closeOnEscape} ref={pickerRef}>
      <button
        aria-controls={open ? pickerId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Insert emoji"
        className={toolbarButtonClass}
        onClick={() => setOpen((current) => !current)}
        title="Insert emoji"
        type="button"
      >
        <FontAwesomeIcon className="h-4 w-4" icon={faFaceSmile} />
      </button>
      {open ? (
        <div className="admin-compose-emoji-menu" id={pickerId} role="dialog">
          <EmojiPickerPanel
            autoFocusSearch={!phoneLayout}
            onSelect={(emoji) => {
              onSelect(emoji)
              setOpen(false)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
