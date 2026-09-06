import { useState } from 'react'
import { EmojiPickerPanel } from '../../../shared/EmojiPickerPanel'
import { BoardIcon } from './BoardIcon'

type BoardIconFieldProps = {
  /** The board this is choosing for, so the control names itself out loud. */
  boardName?: string
  disabled?: boolean
  iconEmoji: string | null
  onChange: (iconEmoji: string | null) => void
}

/**
 * Choose a board's emoji, or clear it back to the shared board icon.
 *
 * The current glyph *is* the button: it shows what the board looks like in the
 * sidebar, so the preview and the control are one thing rather than two that
 * can disagree. Emoji only — a board is a saved way of looking at a project's
 * work, and an upload-and-crop flow would promise more than the row deserves.
 */
export const BoardIconField = ({
  boardName,
  disabled,
  iconEmoji,
  onChange,
}: BoardIconFieldProps) => {
  const [open, setOpen] = useState(false)
  const forBoard = boardName ? ` for ${boardName}` : ''

  return (
    <div className="relative flex items-center">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${iconEmoji ? 'Change' : 'Choose'} board icon${forBoard}`}
        className="admin-button admin-button-secondary admin-button-compact px-2"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <BoardIcon iconEmoji={iconEmoji} size="md" />
      </button>
      {open ? (
        <>
          <button
            aria-hidden="true"
            className="fixed inset-0 cursor-default"
            onClick={() => setOpen(false)}
            style={{ zIndex: 'var(--layer-popover)' }}
            tabIndex={-1}
            type="button"
          />
          <div
            className="absolute left-0 top-full mt-2 w-[min(360px,calc(100vw-4rem))] shadow-xl"
            style={{ zIndex: 'var(--layer-popover)' }}
          >
            {/* Clearing lives in the popover rather than beside the button: a
                list of boards where only some carry an emoji would otherwise
                have its names at two different left edges. */}
            {iconEmoji ? (
              <button
                aria-label={`Remove board icon${forBoard}`}
                className="flex w-full items-center gap-2 rounded-t-xl border border-b-0
                  border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2 text-left
                  text-sm text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)]"
                onClick={() => {
                  setOpen(false)
                  onChange(null)
                }}
                type="button"
              >
                <BoardIcon iconEmoji={null} />
                Use the default icon
              </button>
            ) : null}
            <EmojiPickerPanel
              onSelect={(emoji) => {
                onChange(emoji)
                setOpen(false)
              }}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}
