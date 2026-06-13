import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import { usePresenceLookup, type PresenceView } from '../../../providers/PresenceProvider'
import { UserAvatar, type AvatarSources } from '../../primitives/UserAvatar'
import { MessageAttachments } from '../../shared/MessageAttachments'
import { ChannelAgentGlyph } from './ChannelAgentGlyph'
import { ChannelMessageActions } from './ChannelMessageActions'
import {
  formatClock,
  getDisplayName,
  type FeedItem,
  type MessageUserIdentity,
  type OptimisticMessage,
  type PendingStreamMessage,
} from './channel-helpers'

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
const StatusBadge = ({ presence }: { presence: PresenceView | null }) => {
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

// Tombstone for a deleted message that still has replies below it: a small
// light-dashed bubble in place of the original row (no avatar/name).
const DeletedBubble = () => (
  <div className="py-0.5 pl-12 pr-5">
    <span className="admin-deleted-bubble">Message has been deleted</span>
  </div>
)

interface ChannelMessageFeedProps {
  feedItems: FeedItem[]
  optimisticMessages: OptimisticMessage[]
  pendingMessages: PendingStreamMessage[]
  agentMap: Map<string, AgentRecord>
  agentById: Map<string, AgentRecord>
  meDisplayName: string
  meUserId: string
  // Avatar sources for the signed-in user — used for optimistic (not-yet-saved)
  // messages, which have no server-side author payload yet.
  meAvatar: AvatarSources
  token: string | null
  isPersonalAssistantConversation: boolean
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
}

export const ChannelMessageFeed = ({
  feedItems,
  optimisticMessages,
  pendingMessages,
  agentMap,
  agentById,
  meDisplayName,
  meUserId,
  meAvatar,
  token,
  isPersonalAssistantConversation,
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
}: ChannelMessageFeedProps) => {
  const getPresence = usePresenceLookup()
  const [activeActionMessageId, setActiveActionMessageId] = useState<string | null>(null)
  const [collapsedDateKeys, setCollapsedDateKeys] = useState<Set<string>>(
    () => new Set(),
  )
  const visibleFeedItems = useMemo(() => {
    const visible: FeedItem[] = []
    let activeDateKey: string | null = null

    for (const item of feedItems) {
      if (item.kind === 'date') {
        activeDateKey = item.key
        visible.push(item)
        continue
      }

      if (!activeDateKey || !collapsedDateKeys.has(activeDateKey)) {
        visible.push(item)
      }
    }

    return visible
  }, [collapsedDateKeys, feedItems])
  const toggleDateKey = (dateKey: string) => {
    setCollapsedDateKeys((current) => {
      const next = new Set(current)
      if (next.has(dateKey)) {
        next.delete(dateKey)
      } else {
        next.add(dateKey)
      }
      return next
    })
  }
  // Index of the last actual message; a deleted message only leaves a tombstone
  // bubble when something follows it (otherwise it just disappears).
  const lastMessageIndex = visibleFeedItems.reduce(
    (acc, entry, index) => (entry.kind === 'message' ? index : acc),
    -1,
  )

  return (
    <>
      {feedItems.length === 0 &&
      pendingMessages.length === 0 &&
      optimisticMessages.length === 0 ? (
        <div className="p-5">
          <div className="admin-card p-4 text-sm text-[color:var(--tx3)]">
            No messages yet. Send the first message to start this thread.
          </div>
        </div>
      ) : null}

      {visibleFeedItems.map((item, index) => {
        if (item.kind === 'date') {
          const collapsed = collapsedDateKeys.has(item.key)
          return (
            <div key={`date:${item.key}`} className="admin-date-sep">
              <button
                aria-expanded={!collapsed}
                className="admin-date-pill admin-date-pill-button"
                onClick={() => toggleDateKey(item.key)}
                type="button"
              >
                {item.label}
                <svg
                  className={[
                    'h-3 w-3 flex-shrink-0 transition-transform',
                    collapsed ? '-rotate-90' : '',
                  ].join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  viewBox="0 0 24 24"
                >
                  <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          )
        }

        if (item.message.deletedAt) {
          return index < lastMessageIndex ? <DeletedBubble key={item.message.id} /> : null
        }

        const displayName = getDisplayName(
          item.message,
          meDisplayName,
          agentMap,
          isPersonalAssistantConversation ? 'Personal Assistant' : 'Agent',
        )
        const canManageOwnMessage =
          item.message.role === 'user' && item.message.userId === meUserId
        const isEditingMessage = editingMessageId === item.message.id
        const messageAgent =
          item.message.role === 'assistant' && onSelectAgent
            ? agentMap.get(item.message.agentId ?? '') ?? null
            : null
        const authorIdentity =
          item.message.role === 'user' &&
          item.message.userId &&
          item.message.userId !== meUserId &&
          onSelectUser
            ? {
                avatarAttachmentId: item.message.author?.avatarAttachmentId,
                avatarUrl: item.message.author?.avatarUrl,
                displayName,
                gravatarUrl: item.message.author?.gravatarUrl,
                id: item.message.userId,
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
            key={item.message.id}
            id={`msg-${item.message.id}`}
            aria-label={`Message from ${displayName}`}
            className="admin-msg-row relative py-1"
            data-actions-open={activeActionMessageId === item.message.id}
            onClick={() =>
              setActiveActionMessageId((current) =>
                current === item.message.id ? null : item.message.id,
              )
            }
            onFocus={() => setActiveActionMessageId(item.message.id)}
            tabIndex={0}
          >
            {messageAgent ? (
              <button
                aria-label={`Open ${displayName}`}
                className="rounded-lg outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                onClick={selectAgent}
                type="button"
              >
                <ChannelAgentGlyph agent={messageAgent} />
              </button>
            ) : item.message.role === 'assistant' ? (
              <ChannelAgentGlyph agent={agentMap.get(item.message.agentId ?? '')} />
            ) : authorIdentity ? (
              <button
                aria-label={`Open ${displayName}`}
                className="rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                onClick={selectAuthor}
                type="button"
              >
                <UserAvatar
                  avatarAttachmentId={item.message.author?.avatarAttachmentId ?? undefined}
                  avatarUrl={item.message.author?.avatarUrl ?? undefined}
                  displayName={displayName}
                  gravatarUrl={item.message.author?.gravatarUrl ?? undefined}
                  size={36}
                  token={token}
                />
              </button>
            ) : (
              <UserAvatar
                avatarAttachmentId={item.message.author?.avatarAttachmentId ?? undefined}
                avatarUrl={item.message.author?.avatarUrl ?? undefined}
                displayName={displayName}
                gravatarUrl={item.message.author?.gravatarUrl ?? undefined}
                size={36}
                token={token}
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
                  <span className="text-sm font-bold text-[var(--tx)]">
                    {displayName}
                  </span>
                )}
                {item.message.role === 'user' ? (
                  <StatusBadge presence={getPresence(item.message.userId)} />
                ) : null}
                {item.message.role === 'assistant' && !isPersonalAssistantConversation ? (
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
                  {formatClock(item.message.createdAt)}
                </span>
                {item.message.editedAt ? (
                  <span className="text-xs italic text-[color:var(--tx3)]">(edited)</span>
                ) : null}
              </div>
              <div
                className={
                  item.message.role === 'assistant'
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
                          onSubmitEdit(item.message.id)
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
                        onClick={() => onSubmitEdit(item.message.id)}
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
                    {renderContent(item.message.content)}
                  </p>
                )}
                <MessageAttachments messageId={item.message.id} />
                {!isEditingMessage ? (
                  <ChannelMessageActions
                    canDelete={canManageOwnMessage}
                    canEdit={canManageOwnMessage}
                    content={item.message.content}
                    messageId={item.message.id}
                    reactions={item.message.reactions ?? []}
                    onAddReaction={onAddReaction}
                    onConfirmDelete={onConfirmDelete}
                    onStartEdit={onStartEdit}
                  />
                ) : null}
              </div>
            </div>
          </article>
        )
      })}

      {optimisticMessages.map((entry) => (
        <article
          key={entry.clientId}
          className="admin-msg-row py-1"
          data-testid="optimistic-message"
        >
          <UserAvatar
            avatarAttachmentId={meAvatar.avatarAttachmentId}
            avatarUrl={meAvatar.avatarUrl}
            displayName={meDisplayName}
            gravatarUrl={meAvatar.gravatarUrl}
            size={36}
            token={token}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-bold text-[var(--tx)]">{meDisplayName}</span>
              <StatusBadge presence={getPresence(meUserId)} />
              {entry.status === 'failed' ? (
                <span
                  className={[
                    'inline-flex items-center rounded px-1.5 py-0.5',
                    'bg-[var(--danger-soft)] text-[11px] font-semibold text-[var(--danger-text)]',
                  ].join(' ')}
                >
                  failed
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-xs text-[color:var(--tx3)]"
                  title="Sending…"
                >
                  sending
                  <span className="streaming-dot" />
                </span>
              )}
            </div>
            <div className="mt-0.5">
              <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
                {renderContent(entry.content)}
              </p>
            </div>
          </div>
        </article>
      ))}

      {pendingMessages.length > 0 ? (
        <div className="admin-date-sep">
          <span className="admin-date-pill">
            Live
            <svg
              className="h-3 w-3 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      ) : null}

      {pendingMessages.map((entry) => {
        const pendingAgent = agentById.get(entry.agentId) ?? null
        const pendingDisplayName = isPersonalAssistantConversation
          ? 'Personal Assistant'
          : pendingAgent?.name ?? 'Agent'

        return (
          <article key={entry.runId} className="admin-msg-row py-1">
            <ChannelAgentGlyph agent={pendingAgent} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold text-[var(--tx)]">
                  {pendingDisplayName}
                </span>
                <span
                  className={[
                    'inline-flex items-center rounded',
                    'bg-[var(--accent-soft)] px-2 py-0.5',
                    'text-[11px] font-semibold text-[var(--thinking)]',
                  ].join(' ')}
                >
                  {isPersonalAssistantConversation ? 'thinking' : 'running'}
                </span>
              </div>
              <div className="mt-0.5 border-l-2 border-[var(--accent)] pl-3">
                <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
                  {entry.content ? renderContent(entry.content) : '... thinking ...'}
                  <span className="streaming-dot" />
                </p>
              </div>
            </div>
          </article>
        )
      })}
      <div className="h-3" />
    </>
  )
}
