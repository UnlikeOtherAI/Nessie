import type { Dispatch, MouseEvent, MutableRefObject, ReactNode, SetStateAction } from 'react'
import type { AgentRecord, ThreadMessageRecord } from '../../../lib/api-client'
import type { PresenceView } from '../../../providers/PresenceProvider'
import { UserAvatar, type AvatarSources } from '../../primitives/UserAvatar'
import { MessageAttachments } from '../../shared/MessageAttachments'
import { ChannelAgentGlyph } from './ChannelAgentGlyph'
import { ChannelMessageActions } from './ChannelMessageActions'
import type { ResolveReactorName } from './ReactionPills'
import { formatClock, getDisplayName, type MessageUserIdentity } from './channel-helpers'
import { MessageUiCards } from './MessageUiCards'
import { CommsConnectCard } from './CommsConnectCard'

const SpeechBubbleIcon = () => (
  <svg
    fill="none"
    height="13"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="13"
  >
    <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />
  </svg>
)

// The status chip shown after an author's name: their active status emoji, or a
// speech bubble when they have no emoji. Hovering reveals the status message.
export const StatusBadge = ({ presence }: { presence: PresenceView | null }) => {
  const emoji = presence?.statusEmoji ?? null
  const label = presence?.statusLabel ?? null
  return (
    <span className="admin-status-badge">
      <span className="admin-status-badge-icon">{emoji ?? <SpeechBubbleIcon />}</span>
      {label ? (
        <span className="admin-tooltip" role="tooltip">
          {label}
        </span>
      ) : null}
    </span>
  )
}

interface ChannelMessageRowProps {
  message: ThreadMessageRecord
  agentMap: Map<string, AgentRecord>
  meDisplayName: string
  meUserId: string
  meAvatar: AvatarSources
  token: string | null
  assistantFallbackName: string
  isDedicatedAgentConversation: boolean
  // A first-class external-agent turn (DeepSignal, ...) renders its narrated
  // activities as a collapsed plan/timeline; other surfaces render flat cards.
  isExternalAgentConversation: boolean
  renderContent: (text: string) => ReactNode
  editingMessageId: string | null
  editingContent: string
  updatePending: boolean
  onStartEdit: (messageId: string, content: string) => void
  onChangeEditingContent: (value: string) => void
  onSubmitEdit: (messageId: string) => void
  onCancelEdit: () => void
  onAddReaction: (messageId: string, emoji: string) => void
  onConfirmDelete: (messageId: string) => void
  onSelectAgent?: (agent: AgentRecord) => void
  onSelectUser?: (user: MessageUserIdentity) => void
  resolveReactorName: ResolveReactorName
  getPresence: (userId: string | null | undefined) => PresenceView | null
  activeActionMessageId: string | null
  setActiveActionMessageId: Dispatch<SetStateAction<string | null>>
  lastPointerDownAt: MutableRefObject<number>
}

// One message's row in the feed: avatar, author name + status/agent chips,
// content (or its inline editor), UI cards, attachments, and hover actions.
// Split out of ChannelMessageFeed so the feed component stays focused on
// list/grouping machinery rather than a single row's render logic.
export const ChannelMessageRow = ({
  message,
  agentMap,
  meDisplayName,
  meUserId,
  meAvatar,
  token,
  assistantFallbackName,
  isDedicatedAgentConversation,
  isExternalAgentConversation,
  renderContent,
  editingMessageId,
  editingContent,
  updatePending,
  onStartEdit,
  onChangeEditingContent,
  onSubmitEdit,
  onCancelEdit,
  onAddReaction,
  onConfirmDelete,
  onSelectAgent,
  onSelectUser,
  resolveReactorName,
  getPresence,
  activeActionMessageId,
  setActiveActionMessageId,
  lastPointerDownAt,
}: ChannelMessageRowProps) => {
  const displayName = getDisplayName(message, meDisplayName, agentMap, assistantFallbackName)
  const canManageOwnMessage = message.role === 'user' && message.userId === meUserId
  const isEditingMessage = editingMessageId === message.id
  const messageAgent =
    message.role === 'assistant' && onSelectAgent
      ? agentMap.get(message.agentId ?? '') ?? null
      : null
  const authorIdentity =
    message.role === 'user' && message.userId && onSelectUser
      ? {
          avatarAttachmentId: message.author?.avatarAttachmentId
            ?? (message.userId === meUserId ? meAvatar.avatarAttachmentId : undefined),
          avatarUrl: message.author?.avatarUrl
            ?? (message.userId === meUserId ? meAvatar.avatarUrl : undefined),
          displayName,
          gravatarUrl: message.author?.gravatarUrl
            ?? (message.userId === meUserId ? meAvatar.gravatarUrl : undefined),
          id: message.userId,
        }
      : null
  const selectAuthor = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (authorIdentity) {
      onSelectUser?.(authorIdentity)
    }
  }
  const selectAgent = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (messageAgent) {
      onSelectAgent?.(messageAgent)
    }
  }

  return (
    <article
      key={message.id}
      id={`msg-${message.id}`}
      aria-label={`Message from ${displayName}`}
      className="admin-msg-row relative py-1"
      data-actions-open={activeActionMessageId === message.id}
      onClick={() =>
        setActiveActionMessageId((current) => (current === message.id ? null : message.id))
      }
      onFocus={() => {
        if (Date.now() - lastPointerDownAt.current > 500) {
          setActiveActionMessageId(message.id)
        }
      }}
      onPointerDown={() => {
        lastPointerDownAt.current = Date.now()
      }}
      tabIndex={0}
    >
      {messageAgent ? (
        <button
          aria-label={`Open ${displayName}`}
          className="rounded-lg outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          onClick={selectAgent}
          type="button"
        >
          <ChannelAgentGlyph agent={messageAgent} token={token} />
        </button>
      ) : message.role === 'assistant' ? (
        <ChannelAgentGlyph agent={agentMap.get(message.agentId ?? '')} token={token} />
      ) : authorIdentity ? (
        <button
          aria-label={`Open ${displayName}`}
          className="rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          onClick={selectAuthor}
          type="button"
        >
          <UserAvatar
            avatarAttachmentId={message.author?.avatarAttachmentId ?? undefined}
            avatarUrl={message.author?.avatarUrl ?? undefined}
            displayName={displayName}
            gravatarUrl={message.author?.gravatarUrl ?? undefined}
            size={36}
            token={token}
            userId={message.author?.id}
          />
        </button>
      ) : (
        <UserAvatar
          avatarAttachmentId={message.author?.avatarAttachmentId ?? undefined}
          avatarUrl={message.author?.avatarUrl ?? undefined}
          displayName={displayName}
          gravatarUrl={message.author?.gravatarUrl ?? undefined}
          size={36}
          token={token}
          userId={message.author?.id}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {messageAgent || authorIdentity ? (
            <button
              className="min-w-0 text-left text-sm font-bold text-[var(--tx)] hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={messageAgent ? selectAgent : selectAuthor}
              type="button"
            >
              {displayName}
            </button>
          ) : (
            <span className="text-sm font-bold text-[var(--tx)]">{displayName}</span>
          )}
          {message.role === 'user' ? (
            <StatusBadge presence={getPresence(message.userId)} />
          ) : null}
          {message.role === 'assistant' && !isDedicatedAgentConversation ? (
            <span
              className={[
                'inline-flex items-center gap-1 rounded',
                'border border-[var(--accent)]',
                'bg-[var(--accent-soft)] px-1.5 py-0.5',
                'text-[11px] font-semibold text-[var(--thinking)]',
              ].join(' ')}
            >
              agent
            </span>
          ) : null}
          <span className="text-xs text-[color:var(--tx3)]">
            {formatClock(message.createdAt)}
          </span>
          {message.editedAt ? (
            <span className="text-xs italic text-[color:var(--tx3)]">(edited)</span>
          ) : null}
        </div>
        <div
          className={
            message.role === 'assistant'
              ? 'mt-0.5 border-l-2 border-[var(--accent)] pl-3'
              : 'mt-0.5'
          }
        >
          {isEditingMessage ? (
            <div className="flex flex-col gap-2">
              <textarea
                autoFocus
                className="admin-input w-full resize-y text-sm"
                onChange={(event) => onChangeEditingContent(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    onSubmitEdit(message.id)
                  }
                  if (event.key === 'Escape') {
                    onCancelEdit()
                  }
                }}
                rows={2}
                value={editingContent}
              />
              <div className="flex items-center gap-2">
                <button
                  className="admin-button admin-button-primary"
                  disabled={updatePending}
                  onClick={() => onSubmitEdit(message.id)}
                  type="button"
                >
                  Save
                </button>
                <button
                  className="admin-button admin-button-secondary"
                  onClick={onCancelEdit}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
              {renderContent(message.content)}
            </p>
          )}
          {!isEditingMessage ? (
            <MessageUiCards
              isExternalAgent={
                isExternalAgentConversation && message.role === 'assistant'
              }
              metadata={message.metadata}
            />
          ) : null}
          {!isEditingMessage ? (
            <CommsConnectCard metadata={message.metadata} />
          ) : null}
          <MessageAttachments messageId={message.id} />
          {!isEditingMessage ? (
            <ChannelMessageActions
              canDelete={canManageOwnMessage}
              canEdit={canManageOwnMessage}
              content={message.content}
              currentUserId={meUserId}
              messageId={message.id}
              reactions={message.reactions ?? []}
              resolveReactorName={resolveReactorName}
              onAddReaction={onAddReaction}
              onConfirmDelete={onConfirmDelete}
              onStartEdit={onStartEdit}
            />
          ) : null}
        </div>
      </div>
    </article>
  )
}
