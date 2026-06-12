import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { faChevronDown, faCircleXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

type StatusEmojiPickerProps = {
  label: string
  onChange: (value: string) => void
  value: string
}

const statusEmojiOptions = [
  '💬',
  '🧠',
  '💡',
  '✍️',
  '📚',
  '💻',
  '🛠️',
  '🎧',
  '📞',
  '📹',
  '🗓️',
  '⏳',
  '✅',
  '🚧',
  '🔥',
  '⚡',
  '☕',
  '🍵',
  '🍽️',
  '🥪',
  '🏠',
  '🏢',
  '🚗',
  '✈️',
  '🚆',
  '🏝️',
  '🌴',
  '🌙',
  '😴',
  '🤒',
  '🧘',
  '🎯',
  '🔕',
  '🔒',
  '🙌',
  '👋',
  '🙂',
  '😄',
  '🤔',
  '😭',
  '❤️',
  '⭐',
  '🌟',
  '🎉',
  '🎁',
  '📦',
  '📌',
  '📍',
  '🧭',
  '📣',
  '🔔',
  '💤',
  '🚀',
  '🌈',
  '☀️',
  '🌧️',
  '❄️',
  '🏃',
  '🚶',
  '🧑‍💻',
  '👀',
  '📝',
  '🔍',
  '🧪',
  '📈',
  '📉',
  '🧯',
  '🍕',
  '🎮',
  '🎵',
]

export const StatusEmojiPicker = ({ label, onChange, value }: StatusEmojiPickerProps) => {
  const [open, setOpen] = useState(false)
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickAway = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  const pick = (nextValue: string) => {
    onChange(nextValue)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className="admin-input flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
        type="button"
      >
        <span
          className={
            value
              ? 'text-lg leading-none text-[color:var(--tx)]'
              : 'truncate text-[color:var(--tx3)]'
          }
        >
          {value || 'Icon'}
        </span>
        <FontAwesomeIcon
          className="shrink-0 text-[10px] text-[color:var(--tx3)]"
          icon={faChevronDown}
        />
      </button>
      {open ? (
        <div
          className="absolute left-0 z-50 mt-1 w-72 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-2 shadow-lg"
          id={listboxId}
          role="listbox"
        >
          <div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto">
            <button
              aria-label="Clear icon"
              aria-selected={!value}
              className={[
                'flex aspect-square items-center justify-center rounded text-sm',
                'text-[color:var(--tx3)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
                value ? '' : 'bg-[color:var(--accent-soft)] text-[color:var(--tx)]',
              ].join(' ')}
              onClick={() => pick('')}
              role="option"
              title="Clear icon"
              type="button"
            >
              <FontAwesomeIcon icon={faCircleXmark} />
            </button>
            {statusEmojiOptions.map((emoji) => (
              <button
                aria-label={`Use ${emoji}`}
                aria-selected={value === emoji}
                className={[
                  'flex aspect-square items-center justify-center rounded text-lg',
                  'hover:bg-[color:var(--overlay)]',
                  value === emoji ? 'bg-[color:var(--accent-soft)]' : '',
                ].join(' ')}
                key={emoji}
                onClick={() => pick(emoji)}
                role="option"
                type="button"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
