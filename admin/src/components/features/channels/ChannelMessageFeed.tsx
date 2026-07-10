import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import { usePresenceLookup } from '../../../providers/PresenceProvider'
import { UserAvatar, type AvatarSources } from '../../primitives/UserAvatar'
import { ChannelAgentGlyph } from './ChannelAgentGlyph'
import { ChannelMessageRow, StatusBadge } from './ChannelMessageRow'
import {
  type FeedItem,
  type MessageUserIdentity,
  type OptimisticMessage,
  type PendingStreamMessage,
} from './channel-helpers'

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
  // First-class external-agent conversation (e.g. DeepSignal): same
  // special-casing as the Personal Assistant (author label, no generic
  // "agent" pill, "thinking" wording), but the display name comes from the
  // channel itself so a second external agent needs no code change here.
  isExternalAgentConversation?: boolean
  externalAgentDisplayName?: string
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
  isExternalAgentConversation = false,
  externalAgentDisplayName,
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
  // Both the Personal Assistant and any external agent (DeepSignal, ...) read
  // as a first-class assistant conversation: one dedicated author identity,
  // no generic "agent" pill, "thinking" rather than "running".
  const isDedicatedAgentConversation =
    isPersonalAssistantConversation || isExternalAgentConversation
  const assistantFallbackName = isPersonalAssistantConversation
    ? 'Personal Assistant'
    : isExternalAgentConversation
      ? externalAgentDisplayName ?? 'Agent'
      : 'Agent'
  const [activeActionMessageId, setActiveActionMessageId] = useState<string | null>(null)
  const lastPointerDownAt = useRef(0)
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
          <ChannelMessageRow
            activeActionMessageId={activeActionMessageId}
            agentMap={agentMap}
            assistantFallbackName={assistantFallbackName}
            editingContent={editingContent}
            editingMessageId={editingMessageId}
            getPresence={getPresence}
            isDedicatedAgentConversation={isDedicatedAgentConversation}
            key={item.message.id}
            lastPointerDownAt={lastPointerDownAt}
            meAvatar={meAvatar}
            meDisplayName={meDisplayName}
            meUserId={meUserId}
            message={item.message}
            renderContent={renderContent}
            setActiveActionMessageId={setActiveActionMessageId}
            token={token}
            updatePending={updatePending}
            onAddReaction={onAddReaction}
            onCancelEdit={onCancelEdit}
            onChangeEditingContent={onChangeEditingContent}
            onConfirmDelete={onConfirmDelete}
            onSelectAgent={onSelectAgent}
            onSelectUser={onSelectUser}
            onStartEdit={onStartEdit}
            onSubmitEdit={onSubmitEdit}
          />
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
        const pendingDisplayName = isDedicatedAgentConversation
          ? assistantFallbackName
          : pendingAgent?.name ?? 'Agent'

        return (
          <article key={entry.runId} className="admin-msg-row py-1">
            <ChannelAgentGlyph agent={pendingAgent} token={token} />
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
                  {isDedicatedAgentConversation ? 'thinking' : 'running'}
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
