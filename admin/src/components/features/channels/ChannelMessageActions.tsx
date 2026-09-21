import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Check, Copy, Pencil, Reply, Smile, Trash2 } from 'lucide-react'
import type { MessageReaction } from '../../../lib/api-client'
import { EmojiReactionButton } from '../../shared/EmojiReactionButton'
import { ReactionPills, type ResolveReactorName } from './ReactionPills'

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
  const copiedTimer = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current)
      }
    },
    [],
  )

  const addReaction = (emoji: string) => onAddReaction(messageId, emoji)

  const copyMessage = () => {
    void navigator.clipboard.writeText(content).then(
      () => {
        setCopied(true)
        if (copiedTimer.current !== null) {
          window.clearTimeout(copiedTimer.current)
        }
        copiedTimer.current = window.setTimeout(() => {
          setCopied(false)
        }, 1400)
      },
      () => undefined,
    )
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
        onPointerDown={stopRowToggle}
      >
        <button
          aria-label={copied ? 'Message copied' : 'Copy message'}
          className="admin-msg-action-button"
          onClick={copyMessage}
          title={copied ? 'Copied' : 'Copy message'}
          type="button"
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
        <EmojiReactionButton
          icon={<Smile aria-hidden="true" />}
          onSelect={addReaction}
          title="Add emoji reaction"
        />
        {onReply ? (
          <button
            aria-label="Reply in thread"
            className="admin-msg-action-button"
            onClick={onReply}
            title="Reply in thread"
            type="button"
          >
            <Reply aria-hidden="true" />
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
            <Pencil aria-hidden="true" />
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
            <Trash2 aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </>
  )
}
