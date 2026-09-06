import type { Dispatch, KeyboardEvent, MouseEvent, MutableRefObject, ReactNode, SetStateAction } from 'react'
import type { AgentRecord, PersonalAssistantPresenceParticipant, ThreadMessageRecord } from '../../../lib/api-client'
import type { AttachmentRecord } from '../../../lib/uploads'
import { readWatchStatusSummary } from '../../../facades/channels/watch-status'
import { useAgentIdentityLookup } from '../../../providers/AgentIdentityProvider'
import type { PresenceView } from '../../../providers/PresenceProvider'
import type { AvatarSources } from '../../shared/UserAvatar'
import { UserStatusEmoji } from '../../primitives/UserStatusEmoji'
import { ChannelMessageBody } from './ChannelMessageBody'
import { MessageAuthorAvatar } from './MessageAuthorAvatar'
import type { ResolveReactorName } from './ReactionPills'
import type { DisclosureDuration } from './RestrictedMessageCard'
import { formatClock, getDisplayName } from './channel-feed'
import { type ChannelAgentParticipant, type MessageUserIdentity } from './channel-participants'
import type { ThreadParticipant } from './thread-panel/thread-replies'
import { isAgentCardResponseMessage } from '@nessie/schemas'

const SpeechBubbleIcon = () => (
  <svg fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="13">
    <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />
  </svg>
)

export const StatusBadge = ({ presence }: { presence: PresenceView | null }) => {
  const emoji = presence?.statusEmoji ?? null
  const label = presence?.statusLabel ?? null
  if (emoji) return <UserStatusEmoji statusEmoji={emoji} statusLabel={label} />
  return <span className="admin-status-badge"><span className="admin-status-badge-icon"><SpeechBubbleIcon /></span></span>
}

interface ChannelMessageRowProps {
  message: ThreadMessageRecord
  agentMap: Map<string, AgentRecord>
  meDisplayName: string
  meUserId: string
  meAvatar: AvatarSources
  token: string | null
  assistantFallbackName: string
  personalAssistantPresence: PersonalAssistantPresenceParticipant | null
  isDedicatedAgentConversation: boolean
  isExternalAgentConversation: boolean
  renderContent: (text: string) => ReactNode
  editingMessageId: string | null
  editingContent: string
  updatePending: boolean
  onStartEdit: (messageId: string, content: string) => void
  shareRestrictedMessage?: (messageId: string, input: { kind: 'message' | 'scope'; duration: DisclosureDuration }) => Promise<void>
  onChangeEditingContent: (value: string) => void
  onSubmitEdit: (messageId: string) => void
  onCancelEdit: () => void
  onAddReaction: (messageId: string, emoji: string) => void
  onConfirmDelete: (messageId: string) => void
  onOpenThread?: (rootMessageId: string) => void
  onOpenAttachment?: (attachment: AttachmentRecord) => void
  onSelectAgent?: (agent: ChannelAgentParticipant) => void
  onSelectUser?: (user: MessageUserIdentity) => void
  resolveReactorName: ResolveReactorName
  resolveThreadParticipant?: (participantId: string) => ThreadParticipant | null
  getPresence: (userId: string | null | undefined) => PresenceView | null
  activeActionMessageId: string | null
  setActiveActionMessageId: Dispatch<SetStateAction<string | null>>
  lastPointerDownAt: MutableRefObject<number>
}

// One feed row owns focus and author identity. Cards, attachments and reply
// actions are message payload, so they live in ChannelMessageBody.
export const ChannelMessageRow = ({
  message, agentMap, meDisplayName, meUserId, meAvatar, token,
  assistantFallbackName, personalAssistantPresence, isDedicatedAgentConversation,
  isExternalAgentConversation, renderContent, editingMessageId, editingContent,
  updatePending, onStartEdit, shareRestrictedMessage, onChangeEditingContent,
  onSubmitEdit, onCancelEdit, onAddReaction, onConfirmDelete, onOpenThread,
  onOpenAttachment, onSelectAgent, onSelectUser, resolveReactorName,
  resolveThreadParticipant, getPresence, activeActionMessageId,
  setActiveActionMessageId, lastPointerDownAt,
}: ChannelMessageRowProps) => {
  const watchStatus = readWatchStatusSummary(message.metadata)
  const lookupAgentIdentity = useAgentIdentityLookup()
  const authoringAgent = message.role === 'assistant'
    ? agentMap.get(message.agentId ?? '') ?? lookupAgentIdentity(message.agentId)
    : null
  const displayName = getDisplayName(
    message,
    meDisplayName,
    authoringAgent,
    assistantFallbackName,
    personalAssistantPresence?.displayName,
  )
  const canManageOwnMessage = message.role === 'user' && message.userId === meUserId
  const canEditOwnMessage = canManageOwnMessage && !isAgentCardResponseMessage(message.metadata)
  const isEditingMessage = editingMessageId === message.id
  const threadRootMessageId = message.rootMessageId ?? message.id
  // The entitled map controls actions; the identity directory only resolves a
  // system-managed author's appearance.
  const messageAgent = message.role === 'assistant' && onSelectAgent && !personalAssistantPresence
    ? agentMap.get(message.agentId ?? '') ?? null
    : null
  const assistantAvatar = personalAssistantPresence
    ? {
        avatarAttachmentId: personalAssistantPresence.avatarAttachmentId,
        id: personalAssistantPresence.agentId,
        name: personalAssistantPresence.displayName,
        role: 'Personal Assistant',
      }
    : authoringAgent ?? undefined
  const authorIdentity = message.role === 'user' && message.userId && onSelectUser
    ? {
        avatarAttachmentId: message.author?.avatarAttachmentId
          ?? (message.userId === meUserId ? meAvatar.avatarAttachmentId : undefined),
        avatarUrl: message.author?.avatarUrl ?? (message.userId === meUserId ? meAvatar.avatarUrl : undefined),
        displayName,
        id: message.userId,
      }
    : null
  const selectAuthor = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (authorIdentity) onSelectUser?.(authorIdentity)
  }
  const selectAgent = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (messageAgent) onSelectAgent?.(messageAgent)
  }
  const selectPersonalAssistant = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (personalAssistantPresence) onSelectAgent?.(personalAssistantPresence)
  }
  const openThreadOnKey = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key !== 't' && event.key !== 'T') || !onOpenThread) return
    if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return
    event.preventDefault()
    onOpenThread(threadRootMessageId)
  }

  return (
    <article
      key={message.id}
      id={`msg-${message.id}`}
      aria-label={`Message from ${displayName}`}
      className="admin-msg-row relative py-1"
      data-actions-open={activeActionMessageId === message.id}
      data-message-id={message.id}
      onClick={() => setActiveActionMessageId((current) => (current === message.id ? null : message.id))}
      onFocus={() => {
        if (Date.now() - lastPointerDownAt.current > 500) setActiveActionMessageId(message.id)
      }}
      onKeyDown={openThreadOnKey}
      onPointerDown={() => {
        lastPointerDownAt.current = Date.now()
      }}
      tabIndex={0}
    >
      <MessageAuthorAvatar
        agent={personalAssistantPresence ? assistantAvatar : messageAgent ?? assistantAvatar}
        agentId={personalAssistantPresence?.agentId ?? message.agentId ?? null}
        displayName={displayName}
        isAgent={message.role === 'assistant' || Boolean(personalAssistantPresence)}
        onOpen={
          personalAssistantPresence
            ? selectPersonalAssistant
            : messageAgent
              ? selectAgent
              : authorIdentity
                ? selectAuthor
                : undefined
        }
        user={{
          avatarAttachmentId: message.author?.avatarAttachmentId ?? undefined,
          avatarUrl: message.author?.avatarUrl ?? undefined,
          userId: message.author?.id,
        }}
        token={token}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {personalAssistantPresence || messageAgent || authorIdentity ? (
            <button
              className="min-w-0 text-left text-sm font-bold text-[var(--tx)] hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={personalAssistantPresence ? selectPersonalAssistant : messageAgent ? selectAgent : selectAuthor}
              type="button"
            >
              {displayName}
            </button>
          ) : <span className="text-sm font-bold text-[var(--tx)]">{displayName}</span>}
          {message.role === 'user' ? <StatusBadge presence={getPresence(message.userId)} /> : null}
          {message.role === 'assistant' && !isDedicatedAgentConversation ? (
            <span className="inline-flex items-center gap-1 rounded border border-[var(--accent)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--thinking)]">
              {personalAssistantPresence ? 'PA' : 'agent'}
            </span>
          ) : null}
          <span className="text-xs text-[color:var(--tx3)]">{formatClock(message.createdAt)}</span>
          {watchStatus ? (
            <span className="text-xs text-[color:var(--tx3)]">{`checked ${watchStatus.runCount}× · last ${formatClock(watchStatus.lastRunAt)}`}</span>
          ) : message.editedAt ? <span className="text-xs italic text-[color:var(--tx3)]">(edited)</span> : null}
        </div>
        <ChannelMessageBody
          canDelete={canManageOwnMessage}
          canEdit={canEditOwnMessage}
          editingContent={editingContent}
          isEditingMessage={isEditingMessage}
          isExternalAgentConversation={isExternalAgentConversation}
          meUserId={meUserId}
          message={message}
          resolveReactorName={resolveReactorName}
          resolveThreadParticipant={resolveThreadParticipant}
          renderContent={renderContent}
          shareRestrictedMessage={shareRestrictedMessage}
          token={token}
          updatePending={updatePending}
          onAddReaction={onAddReaction}
          onCancelEdit={onCancelEdit}
          onChangeEditingContent={onChangeEditingContent}
          onConfirmDelete={onConfirmDelete}
          onOpenAttachment={onOpenAttachment}
          onOpenThread={onOpenThread}
          onStartEdit={onStartEdit}
          onSubmitEdit={onSubmitEdit}
        />
      </div>
    </article>
  )
}
