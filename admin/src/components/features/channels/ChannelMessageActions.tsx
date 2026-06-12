import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  faFaceSmile,
  faPen,
  faThumbsUp,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { EmojiClickData, EmojiStyle, Theme } from 'emoji-picker-react'
import type { MessageReaction } from '../../../lib/api-client'
import { toolbarButtonClass } from './channel-helpers'

const FullEmojiPicker = lazy(() => import('emoji-picker-react'))
const THUMBS_UP = '\u{1F44D}'

type ChannelMessageActionsProps = {
  canDelete: boolean
  canEdit: boolean
  content: string
  messageId: string
  reactions: MessageReaction[]
  onAddReaction: (messageId: string, emoji: string) => void
  onConfirmDelete: (messageId: string) => void
  onStartEdit: (messageId: string, content: string) => void
}

const stopRowToggle = (
  event:
    | KeyboardEvent<HTMLElement>
    | MouseEvent<HTMLElement>
    | ReactPointerEvent<HTMLElement>,
) => {
  event.stopPropagation()
}

export const ChannelMessageActions = ({
  canDelete,
  canEdit,
  content,
  messageId,
  reactions,
  onAddReaction,
  onConfirmDelete,
  onStartEdit,
}: ChannelMessageActionsProps) => {
  const pickerId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const reactionSummary = useMemo(() => {
    const counts = new Map<string, number>()
    for (const reaction of reactions) {
      counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1)
    }
    return Array.from(counts, ([emoji, count]) => ({ count, emoji }))
  }, [reactions])

  useEffect(() => {
    if (!pickerOpen) {
      return undefined
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [pickerOpen])

  const addReaction = (emoji: string) => {
    onAddReaction(messageId, emoji)
    setPickerOpen(false)
  }

  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      setPickerOpen(false)
    }
  }

  return (
    <>
      {reactionSummary.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1" onClick={stopRowToggle}>
          {reactionSummary.map(({ count, emoji }) => (
            <button
              key={emoji}
              aria-label={`Add ${emoji} reaction`}
              className="reaction-pill"
              onClick={() => addReaction(emoji)}
              title={`Add ${emoji} reaction`}
              type="button"
            >
              {emoji}
              {count > 1 ? ` ${count}` : ''}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className="admin-msg-actions"
        data-testid="message-actions"
        onClick={stopRowToggle}
        onKeyDown={closeOnEscape}
        onPointerDown={stopRowToggle}
      >
        <button
          aria-label="Add thumbs up reaction"
          className={toolbarButtonClass}
          onClick={() => addReaction(THUMBS_UP)}
          title="Add thumbs up reaction"
          type="button"
        >
          <FontAwesomeIcon className="text-[13px]" icon={faThumbsUp} />
        </button>
        <div className="relative" ref={pickerRef}>
          <button
            aria-controls={pickerOpen ? pickerId : undefined}
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
            aria-label="Add emoji reaction"
            className={toolbarButtonClass}
            onClick={() => setPickerOpen((current) => !current)}
            title="Add emoji reaction"
            type="button"
          >
            <FontAwesomeIcon className="text-[13px]" icon={faFaceSmile} />
          </button>
          {pickerOpen ? (
            <div className="admin-msg-emoji-menu" id={pickerId} role="dialog">
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
                  onEmojiClick={(emojiData: EmojiClickData) => addReaction(emojiData.emoji)}
                  previewConfig={{ showPreview: false }}
                  searchPlaceholder="Search emojis"
                  theme={'auto' as Theme}
                  width="100%"
                />
              </Suspense>
            </div>
          ) : null}
        </div>
        {canEdit ? (
          <button
            aria-label="Edit message"
            className={toolbarButtonClass}
            onClick={() => onStartEdit(messageId, content)}
            title="Edit message"
            type="button"
          >
            <FontAwesomeIcon className="text-[13px]" icon={faPen} />
          </button>
        ) : null}
        {canDelete ? (
          <button
            aria-label="Delete message"
            className={toolbarButtonClass}
            onClick={() => onConfirmDelete(messageId)}
            title="Delete message"
            type="button"
          >
            <FontAwesomeIcon className="text-[13px]" icon={faTrashCan} />
          </button>
        ) : null}
      </div>
    </>
  )
}
