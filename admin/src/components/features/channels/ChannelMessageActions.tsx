import {
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
import type { MessageReaction } from '../../../lib/api-client'
import { EmojiPickerPanel } from '../../shared/EmojiPickerPanel'

const THUMBS_UP = '\u{1F44D}'

type ChannelMessageActionsProps = {
  canDelete: boolean
  canEdit: boolean
  content: string
  currentUserId: string
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
  currentUserId,
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
    const counts = new Map<
      string,
      { count: number; emoji: string; reactedByMe: boolean }
    >()
    for (const reaction of reactions) {
      const summary = counts.get(reaction.emoji) ?? {
        count: 0,
        emoji: reaction.emoji,
        reactedByMe: false,
      }
      summary.count += 1
      summary.reactedByMe ||= reaction.userId === currentUserId
      counts.set(reaction.emoji, summary)
    }
    return Array.from(counts.values())
  }, [currentUserId, reactions])

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
          {reactionSummary.map(({ count, emoji, reactedByMe }) => {
            const label = reactedByMe
              ? `Remove ${emoji} reaction`
              : `Add ${emoji} reaction`

            return (
              <button
                key={emoji}
                aria-label={label}
                aria-pressed={reactedByMe}
                className={
                  reactedByMe ? 'reaction-pill reaction-pill-active' : 'reaction-pill'
                }
                onClick={() => addReaction(emoji)}
                title={label}
                type="button"
              >
                {emoji}
                {count > 1 ? ` ${count}` : ''}
              </button>
            )
          })}
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
          className="admin-msg-action-button"
          onClick={() => addReaction(THUMBS_UP)}
          title="Add thumbs up reaction"
          type="button"
        >
          <FontAwesomeIcon icon={faThumbsUp} />
        </button>
        <div className="relative" ref={pickerRef}>
          <button
            aria-controls={pickerOpen ? pickerId : undefined}
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
            aria-label="Add emoji reaction"
            className="admin-msg-action-button"
            onClick={() => setPickerOpen((current) => !current)}
            title="Add emoji reaction"
            type="button"
          >
            <FontAwesomeIcon icon={faFaceSmile} />
          </button>
          {pickerOpen ? (
            <div className="admin-msg-emoji-menu" id={pickerId} role="dialog">
              <EmojiPickerPanel onSelect={addReaction} />
            </div>
          ) : null}
        </div>
        {canEdit ? (
          <button
            aria-label="Edit message"
            className="admin-msg-action-button"
            onClick={() => onStartEdit(messageId, content)}
            title="Edit message"
            type="button"
          >
            <FontAwesomeIcon icon={faPen} />
          </button>
        ) : null}
        {canDelete ? (
          <button
            aria-label="Delete message"
            className="admin-msg-action-button"
            onClick={() => onConfirmDelete(messageId)}
            title="Delete message"
            type="button"
          >
            <FontAwesomeIcon icon={faTrashCan} />
          </button>
        ) : null}
      </div>
    </>
  )
}
