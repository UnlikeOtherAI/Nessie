import { useMemo } from 'react'
import { Check, Pencil, Reply, RotateCcw, Smile, ThumbsUp, Trash2 } from 'lucide-react'
import type { KnowledgeAnnotationReaction } from '../../../../facades/knowledge/comment-hooks'
import { EmojiReactionButton } from '../../../shared/EmojiReactionButton'
import { SharedActionButton, SharedActionToolbar } from '../../../shared/ActionToolbar'

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

      <SharedActionToolbar onClick={stop} onPointerDown={stop}>
        <SharedActionButton
          aria-label="Add thumbs up reaction"
          onClick={() => react(THUMBS_UP)}
          title="Thumbs up"
          type="button"
        >
          <ThumbsUp aria-hidden="true" />
        </SharedActionButton>
        <EmojiReactionButton
          icon={<Smile aria-hidden="true" />}
          onSelect={react}
          title="Add reaction"
        />
        {topLevel ? (
          <SharedActionButton
            aria-label="Reply"
            onClick={onReply}
            title="Reply"
            type="button"
          >
            <Reply aria-hidden="true" />
          </SharedActionButton>
        ) : null}
        {topLevel && canResolve ? (
          <SharedActionButton
            aria-label={resolved ? 'Reopen' : 'Resolve'}
            onClick={onResolveToggle}
            title={resolved ? 'Reopen' : 'Resolve'}
            type="button"
          >
            {resolved ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
          </SharedActionButton>
        ) : null}
        {canModify ? (
          <SharedActionButton
            aria-label="Edit"
            onClick={onEdit}
            title="Edit"
            type="button"
          >
            <Pencil aria-hidden="true" />
          </SharedActionButton>
        ) : null}
        {canModify ? (
          <SharedActionButton
            aria-label="Delete"
            onClick={onDelete}
            title="Delete"
            type="button"
          >
            <Trash2 aria-hidden="true" />
          </SharedActionButton>
        ) : null}
      </SharedActionToolbar>
    </>
  )
}
