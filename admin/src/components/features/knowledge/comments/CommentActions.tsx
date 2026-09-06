import { useMemo } from 'react'
import {
  faCheck,
  faPen,
  faReply,
  faRotateLeft,
  faThumbsUp,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgeAnnotationReaction } from '../../../../facades/knowledge/comment-hooks'
import { EmojiReactionButton } from '../../../shared/EmojiReactionButton'

const THUMBS_UP = '\u{1F44D}'

type CommentActionsProps = {
  reactions: KnowledgeAnnotationReaction[]
  currentUserId?: string
  canModify: boolean
  canResolve: boolean
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
  canResolve,
  topLevel,
  resolved,
  onToggleReaction,
  onReply,
  onResolveToggle,
  onEdit,
  onDelete,
}: CommentActionsProps) => {
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

  const react = (emoji: string) => onToggleReaction(emoji)

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
              onClick={() => react(emoji)}
              type="button"
            >
              {emoji}
              {count > 1 ? ` ${count}` : ''}
            </button>
          ))}
        </div>
      ) : null}

      <div className="admin-msg-actions" onClick={stop} onPointerDown={stop}>
        <button
          aria-label="Add thumbs up reaction"
          className="admin-msg-action-button"
          onClick={() => react(THUMBS_UP)}
          title="Thumbs up"
          type="button"
        >
          <FontAwesomeIcon icon={faThumbsUp} />
        </button>
        <EmojiReactionButton onSelect={react} title="Add reaction" />
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
        {topLevel && canResolve ? (
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
      </div>
    </>
  )
}
