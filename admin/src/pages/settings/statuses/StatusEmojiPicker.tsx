import { Suspense, lazy, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { faChevronDown, faCircleXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { EmojiClickData, EmojiStyle, Theme } from 'emoji-picker-react'

type StatusEmojiPickerProps = {
  label: string
  onChange: (value: string) => void
  value: string
}

const FullEmojiPicker = lazy(() => import('emoji-picker-react'))

export const StatusEmojiPicker = ({ label, onChange, value }: StatusEmojiPickerProps) => {
  const [open, setOpen] = useState(false)
  const pickerId = useId()
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

  const pickEmoji = (emojiData: EmojiClickData) => {
    pick(emojiData.emoji)
  }

  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-controls={open ? pickerId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="admin-input flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={closeOnEscape}
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
          className="absolute left-0 z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-2 shadow-lg"
          id={pickerId}
          onKeyDown={closeOnEscape}
          role="dialog"
        >
          <div className="mb-2 flex justify-end">
            <button
              aria-label="Clear icon"
              className={[
                'flex h-8 w-8 items-center justify-center rounded text-sm',
                'text-[color:var(--tx3)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
                value ? '' : 'bg-[color:var(--accent-soft)] text-[color:var(--tx)]',
              ].join(' ')}
              onClick={() => pick('')}
              title="Clear icon"
              type="button"
            >
              <FontAwesomeIcon icon={faCircleXmark} />
            </button>
          </div>
          <Suspense
            fallback={
              <div className="flex h-64 items-center justify-center text-sm text-[color:var(--tx3)]">
                Loading emojis...
              </div>
            }
          >
            <FullEmojiPicker
              autoFocusSearch
              emojiStyle={'native' as EmojiStyle}
              height={360}
              lazyLoadEmojis
              onEmojiClick={pickEmoji}
              previewConfig={{ showPreview: false }}
              searchPlaceholder="Search emojis"
              theme={'auto' as Theme}
              width="100%"
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  )
}
