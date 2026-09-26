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
import { SharedActionButton, SharedActionToolbar } from '../../shared/ActionToolbar'
import { ReactionPills, type ResolveReactorName } from './ReactionPills'

type ChannelMessageActionsProps = {
  canDelete: boolean
  canEdit: boolean
  content: string
  currentUserId: string
  messageId: string
  requiresConfirmation?: boolean
  reactions: MessageReaction[]
  resolveReactorName: ResolveReactorName
  onAddReaction: (messageId: string, emoji: string) => void
  onConfirmDelete: (messageId: string, requiresConfirmation?: boolean) => void
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
  requiresConfirmation,
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

      <SharedActionToolbar
        data-testid="message-actions"
        onClick={stopRowToggle}
        onPointerDown={stopRowToggle}
      >
        <SharedActionButton
          aria-label={copied ? 'Message copied' : 'Copy message'}
          onClick={copyMessage}
          title={copied ? 'Copied' : 'Copy message'}
          type="button"
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </SharedActionButton>
        <EmojiReactionButton
          icon={<Smile aria-hidden="true" />}
          onSelect={addReaction}
          title="Add emoji reaction"
        />
        {onReply ? (
          <SharedActionButton
            aria-label="Reply in thread"
            onClick={onReply}
            title="Reply in thread"
            type="button"
          >
            <Reply aria-hidden="true" />
          </SharedActionButton>
        ) : null}
        {canEdit ? (
          <SharedActionButton
            aria-label="Edit message"
            onClick={() => onStartEdit(messageId, content)}
            title="Edit message"
            type="button"
          >
            <Pencil aria-hidden="true" />
          </SharedActionButton>
        ) : null}
        {canDelete ? (
          <SharedActionButton
            aria-label="Delete message"
            onClick={() => onConfirmDelete(messageId, requiresConfirmation)}
            title="Delete message"
            type="button"
          >
            <Trash2 aria-hidden="true" />
          </SharedActionButton>
        ) : null}
      </SharedActionToolbar>
    </>
  )
}
