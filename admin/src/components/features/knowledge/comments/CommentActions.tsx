import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  faCheck,
  faFaceSmile,
  faPen,
  faReply,
  faRotateLeft,
  faThumbsUp,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgeAnnotationReaction } from '../../../../facades/knowledge/comment-hooks'
import { EmojiPickerPanel } from '../../../shared/EmojiPickerPanel'

const THUMBS_UP = '\u{1F44D}'

type CommentActionsProps = {
  reactions: KnowledgeAnnotationReaction[]
  currentUserId?: string
  canModify: boolean
  canInteract: boolean
  topLevel: boolean
  resolved: boolean
  onToggleReaction: (emoji: string) => void
  onReply: () => void
  onResolveToggle: () => void
  onEdit: () => void
  onDelete: () => void
}

// Hover action bar + reaction pills for a comment/note row, matching the channel
// message chrome (reaction-pill / admin-msg-actions) but adding Reply + Resolve.
export const CommentActions = ({
  reactions,
  currentUserId,
  canModify,
  canInteract,
  topLevel,
  resolved,
  onToggleReaction,
  onReply,
  onResolveToggle,
  onEdit,
  onDelete,
}: CommentActionsProps) => {
  const pickerId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const reactionSummary = useMemo(() => {
    const counts = new Map<string, { count: number; emoji: string; reactedByMe: boolean }>()
    for (const reaction of reactions) {
      const summary = counts.get(reaction.emoji) ?? { count: 0, emoji: reaction.emoji, reactedByMe: false }
      summary.count += 1
      summary.reactedByMe ||= Boolean(currentUserId) && reaction.userId === currentUserId
      counts.set(reaction.emoji, summary)
    }
    return Array.from(counts.values())
  }, [currentUserId, reactions])

  useEffect(() => {
    if (!pickerOpen) return undefined
    const closeOnOutside = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    return () => document.removeEventListener('pointerdown', closeOnOutside)
  }, [pickerOpen])

  const react = (emoji: string) => {
    onToggleReaction(emoji)
    setPickerOpen(false)
  }

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

  return (
    <>
      {reactionSummary.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1" onClick={stop}>
          {reactionSummary.map(({ count, emoji, reactedByMe }) => (
            <button
              key={emoji}
              aria-pressed={reactedByMe}
              className={reactedByMe ? 'reaction-pill reaction-pill-active' : 'reaction-pill'}
              disabled={!canInteract}
              onClick={() => canInteract && react(emoji)}
              type="button"
            >
              {emoji}
              {count > 1 ? ` ${count}` : ''}
            </button>
          ))}
        </div>
      ) : null}

      {canInteract ? <div className="admin-msg-actions" onClick={stop} onPointerDown={stop}>
        <button
          aria-label="Add thumbs up reaction"
          className="admin-msg-action-button"
          onClick={() => react(THUMBS_UP)}
          title="Thumbs up"
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
            onClick={() => setPickerOpen((open) => !open)}
            title="Add reaction"
            type="button"
          >
            <FontAwesomeIcon icon={faFaceSmile} />
          </button>
          {pickerOpen ? (
            <div className="admin-msg-emoji-menu" id={pickerId} role="dialog">
              <EmojiPickerPanel onSelect={react} />
            </div>
          ) : null}
        </div>
        {topLevel ? (
          <button
            aria-label="Reply"
            className="admin-msg-action-button"
            onClick={onReply}
            title="Reply"
            type="button"
          >
            <FontAwesomeIcon icon={faReply} />
          </button>
        ) : null}
        {topLevel ? (
          <button
            aria-label={resolved ? 'Reopen' : 'Resolve'}
            className="admin-msg-action-button"
            onClick={onResolveToggle}
            title={resolved ? 'Reopen' : 'Resolve'}
            type="button"
          >
            <FontAwesomeIcon icon={resolved ? faRotateLeft : faCheck} />
          </button>
        ) : null}
        {canModify ? (
          <button
            aria-label="Edit"
            className="admin-msg-action-button"
            onClick={onEdit}
            title="Edit"
            type="button"
          >
            <FontAwesomeIcon icon={faPen} />
          </button>
        ) : null}
        {canModify ? (
          <button
            aria-label="Delete"
            className="admin-msg-action-button"
            onClick={onDelete}
            title="Delete"
            type="button"
          >
            <FontAwesomeIcon icon={faTrashCan} />
          </button>
        ) : null}
      </div> : null}
    </>
  )
}
