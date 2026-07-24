import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  faFaceSmile,
  faPen,
  faReply,
  faThumbsUp,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { MessageReaction } from '../../../lib/api-client'
import { EmojiPickerPanel } from '../../shared/EmojiPickerPanel'
import { ReactionPills, type ResolveReactorName } from './ReactionPills'

const THUMBS_UP = '\u{1F44D}'

type ChannelMessageActionsProps = {
  canDelete: boolean
  canEdit: boolean
  content: string
  currentUserId: string
  messageId: string
  reactions: MessageReaction[]
  resolveReactorName: ResolveReactorName
  onAddReaction: (messageId: string, emoji: string) => void
  onConfirmDelete: (messageId: string) => void
  onReply?: () => void
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
  resolveReactorName,
  onAddReaction,
  onConfirmDelete,
  onReply,
  onStartEdit,
}: ChannelMessageActionsProps) => {
  const pickerId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

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
      <ReactionPills
        currentUserId={currentUserId}
        reactions={reactions}
        resolveReactorName={resolveReactorName}
        onToggle={addReaction}
      />

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
        {onReply ? (
          <button
            aria-label="Reply in thread"
            className="admin-msg-action-button"
            onClick={onReply}
            title="Reply in thread"
            type="button"
          >
            <FontAwesomeIcon icon={faReply} />
          </button>
        ) : null}
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
