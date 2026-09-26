import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('channels')
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
          aria-label={copied ? t('messageActions.copied') : t('messageActions.copy')}
          onClick={copyMessage}
          title={copied ? t('messageActions.copiedShort') : t('messageActions.copy')}
          type="button"
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </SharedActionButton>
        <EmojiReactionButton
          icon={<Smile aria-hidden="true" />}
          onSelect={addReaction}
          title={t('messageActions.addReaction')}
        />
        {onReply ? (
          <SharedActionButton
            aria-label={t('messageActions.reply')}
            onClick={onReply}
            title={t('messageActions.reply')}
            type="button"
          >
            <Reply aria-hidden="true" />
          </SharedActionButton>
        ) : null}
        {canEdit ? (
          <SharedActionButton
            aria-label={t('messageActions.edit')}
            onClick={() => onStartEdit(messageId, content)}
            title={t('messageActions.edit')}
            type="button"
          >
            <Pencil aria-hidden="true" />
          </SharedActionButton>
        ) : null}
        {canDelete ? (
          <SharedActionButton
            aria-label={t('messageActions.delete')}
            onClick={() => onConfirmDelete(messageId)}
            title={t('messageActions.delete')}
            type="button"
          >
            <Trash2 aria-hidden="true" />
          </SharedActionButton>
        ) : null}
      </SharedActionToolbar>
    </>
  )
}
