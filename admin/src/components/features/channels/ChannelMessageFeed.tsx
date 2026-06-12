import { useMemo, useState, type ReactNode } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import { usePresenceLookup, type PresenceView } from '../../../providers/PresenceProvider'
import { UserAvatar, type AvatarSources } from '../../primitives/UserAvatar'
import { MessageAttachments } from '../../shared/MessageAttachments'
import {
  formatClock,
  getAgentGlyph,
  getDisplayName,
  toolbarButtonClass,
  type FeedItem,
  type OptimisticMessage,
} from './channel-helpers'

interface PendingStreamMessage {
  agentId: string
  content: string
  reasoningContent: string
  runId: string
}

const PencilIcon = () => (
  <svg
    fill="none"
    height="15"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="15"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

const TrashIcon = () => (
  <svg
    fill="none"
    height="15"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="15"
  >
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0-1 14H6L5 6" />
  </svg>
)

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
  onConfirmDelete: (messageId: string) => void
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
  onConfirmDelete,
}: ChannelMessageFeedProps) => {
  const getPresence = usePresenceLookup()
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

        return (
          <article
            key={item.message.id}
            id={`msg-${item.message.id}`}
            className="admin-msg-row group relative py-1"
          >
            {item.message.role === 'assistant' ? (
              <div
                className={[
                  'flex h-9 w-9 flex-shrink-0 items-center justify-center',
                  'rounded-lg border border-[var(--accent)]',
                  'bg-[var(--accent-soft)] text-lg',
                ].join(' ')}
              >
                {getAgentGlyph(agentMap.get(item.message.agentId ?? ''))}
              </div>
            ) : (
              <UserAvatar
                avatarAttachmentId={item.message.author?.avatarAttachmentId ?? undefined}
                avatarUrl={item.message.author?.avatarUrl ?? undefined}
                displayName={getDisplayName(
                  item.message,
                  meDisplayName,
                  agentMap,
                  isPersonalAssistantConversation ? 'Personal Assistant' : 'Agent',
                )}
                gravatarUrl={item.message.author?.gravatarUrl ?? undefined}
                size={36}
                token={token}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold text-[var(--tx)]">
                  {getDisplayName(
                    item.message,
                    meDisplayName,
                    agentMap,
                    isPersonalAssistantConversation ? 'Personal Assistant' : 'Agent',
                  )}
                </span>
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
                {editingMessageId === item.message.id ? (
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
                {item.message.reactions?.length ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {Object.entries(
                      item.message.reactions.reduce<Record<string, number>>((acc, r) => {
                        acc[r.emoji] = (acc[r.emoji] ?? 0) + 1
                        return acc
                      }, {}),
                    ).map(([emoji, count]) => (
                      <span key={emoji} className="reaction-pill">
                        {emoji}
                        {count > 1 ? ` ${count}` : ''}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            {item.message.role === 'user' &&
            item.message.userId === meUserId &&
            editingMessageId !== item.message.id ? (
              <div className="absolute right-3 top-1 hidden items-center gap-1 group-hover:flex">
                <button
                  className={toolbarButtonClass}
                  onClick={() => onStartEdit(item.message.id, item.message.content)}
                  title="Edit message"
                  type="button"
                >
                  <PencilIcon />
                </button>
                <button
                  className={toolbarButtonClass}
                  onClick={() => onConfirmDelete(item.message.id)}
                  title="Delete message"
                  type="button"
                >
                  <TrashIcon />
                </button>
              </div>
            ) : null}
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
            <div
              className={[
                'flex h-9 w-9 flex-shrink-0 items-center justify-center',
                'rounded-lg border border-[var(--accent)]',
                'bg-[var(--accent-soft)] text-lg',
              ].join(' ')}
            >
              {getAgentGlyph(pendingAgent)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold text-[var(--tx)]">{pendingDisplayName}</span>
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
