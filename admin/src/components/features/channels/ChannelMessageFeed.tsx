import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AgentRecord,
  PersonalAssistantPresenceParticipant,
  UserRecord,
} from '../../../lib/api-client'
import {
  emptyDocumentStore,
  type DocumentStreamStore,
} from '../../../facades/threads/document-stream-store'
import type { DocumentStreamEntry } from '../../../facades/threads/document-stream-helpers'
import {
  groupPendingByRoot,
  type PendingStreamMessage,
} from '../../../facades/threads/thinking'
import { usePresenceLookup } from '../../../providers/PresenceProvider'
import type { AvatarSources } from '../../primitives/UserAvatar'
import { ChannelMessageRow } from './ChannelMessageRow'
import type { DisclosureDuration } from './RestrictedMessageCard'
import { OptimisticMessageRow, StreamingMessageRow } from './ChannelTransientMessageRows'
import { ThinkingBubble } from './ThinkingBubble'
import { useAttachmentViewer } from '../../shared/AttachmentViewer'
import { useDocumentStreamDialog } from './DocumentStreamDialog'
import { useThoughtProcessDialog } from './ThoughtProcessDialog'
import {
  type FeedItem,
  type ChannelAgentParticipant,
  type MessageUserIdentity,
  type OptimisticMessage,
} from './channel-helpers'
import type { ThreadParticipant } from './thread-panel/thread-panel-helpers'
import {
  indexPersonalAssistantPresences,
  personalAssistantPresenceKey,
} from './personal-assistant-presence'
import { useResolveReactorName } from './useResolveReactorName'

// Stable identity so a feed without a document facade never re-runs the
// dialog's effects on a fresh array.
const EMPTY_DOCUMENT_SESSIONS: DocumentStreamEntry[] = []

// Tombstone for a deleted message that still has replies below it: a small
// light-dashed bubble in place of the original row (no avatar/name).
const DeletedBubble = () => (
  <div className="py-0.5 pl-12 pr-5">
    <span className="admin-deleted-bubble">Message has been deleted</span>
  </div>
)

interface ChannelMessageFeedProps {
  // Documents an agent is writing into this conversation (`useThreadStream`).
  // Optional: the read-only info drawers render a feed with no live surface, so
  // they pass nothing and get no popup.
  documentSessions?: DocumentStreamEntry[]
  documentStore?: DocumentStreamStore
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
  // Channel members, when the host has them — lets the "who reacted" popover
  // name members who reacted without ever posting in the thread.
  channelUsers?: UserRecord[]
  personalAssistantPresences?: PersonalAssistantPresenceParticipant[]
  token: string | null
  isPersonalAssistantConversation: boolean
  // First-class external-agent conversation (e.g. DeepSignal): same
  // special-casing as the Personal Assistant (author label, no generic
  // "agent" pill, "thinking" wording), but the display name comes from the
  // channel itself so a second external agent needs no code change here.
  isExternalAgentConversation?: boolean
  externalAgentDisplayName?: string
  // Optional replacement for the default "No messages yet" card when the thread
  // is empty — used to show the external-agent identity + conversation starters.
  emptyState?: ReactNode
  renderContent: (text: string) => ReactNode
  editingMessageId: string | null
  editingContent: string
  updatePending: boolean
  onStartEdit: (messageId: string, content: string) => void
  /**
   * Answer the acknowledgement card on a reply that used restricted sources.
   * Optional: the info drawers render read-only message lists where sharing is
   * not the surface, so they omit it and the card shows without its controls.
   */
  shareRestrictedMessage?: (
    messageId: string,
    input: { kind: 'message' | 'scope'; duration: DisclosureDuration },
  ) => Promise<void>
  onChangeEditingContent: (value: string) => void
  onSubmitEdit: (messageId: string) => void
  onCancelEdit: () => void
  onAddReaction: (messageId: string, emoji: string) => void
  onConfirmDelete: (messageId: string) => void
  // Opens the reply-thread panel for a message's root (#233); when absent the
  // feed renders no thread affordances.
  onOpenThread?: (rootMessageId: string) => void
  onSelectAgent?: (agent: ChannelAgentParticipant) => void
  onSelectUser?: (user: MessageUserIdentity) => void
  resolveThreadParticipant?: (participantId: string) => ThreadParticipant | null
  // Ambient liveness (`useAgentLivenessHint`): one quiet, anonymous line at the
  // bottom while the viewer's just-sent message has produced no signal yet. The
  // host guarantees it is false whenever this surface renders a thinking
  // bubble, so the two never stack.
  showLivenessHint?: boolean
  // Container thread of this feed — the thought-process dialog reads a run's
  // full log from it.
  threadId?: string
  // Where a thinking bubble belongs on this surface. In the channel feed a
  // thread-anchored run gets a compact bubble under its root and only top-level
  // runs get the full bubble at the bottom; a reply panel is already scoped to
  // one root, so every run it is handed lands at the bottom of its list.
  thinkingSurface?: 'channel' | 'thread'
}

export const ChannelMessageFeed = ({
  documentSessions,
  documentStore,
  feedItems,
  optimisticMessages,
  pendingMessages,
  agentMap,
  agentById,
  meDisplayName,
  meUserId,
  meAvatar,
  channelUsers,
  personalAssistantPresences = [],
  token,
  isPersonalAssistantConversation,
  isExternalAgentConversation = false,
  externalAgentDisplayName,
  emptyState,
  renderContent,
  editingMessageId,
  editingContent,
  updatePending,
  onStartEdit,
  shareRestrictedMessage,
  onChangeEditingContent,
  onSubmitEdit,
  onCancelEdit,
  onAddReaction,
  onConfirmDelete,
  onOpenThread,
  onSelectAgent,
  onSelectUser,
  resolveThreadParticipant,
  showLivenessHint = false,
  threadId,
  thinkingSurface = 'channel',
}: ChannelMessageFeedProps) => {
  const getPresence = usePresenceLookup()
  const personalAssistantPresenceByIdentity = useMemo(
    () => indexPersonalAssistantPresences(personalAssistantPresences),
    [personalAssistantPresences],
  )
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
  // One identity resolution for both the streaming reply rows and the bubbles.
  const resolveAgentIdentity = useCallback(
    (agentId: string) => {
      const agent = agentById.get(agentId) ?? null
      return {
        agent,
        name: isDedicatedAgentConversation ? assistantFallbackName : agent?.name ?? 'Agent',
      }
    },
    [agentById, assistantFallbackName, isDedicatedAgentConversation],
  )
  // Full-size attachment viewer, owned here so it works identically from the
  // channel feed, the reply panel, and the info drawers — same seam as the
  // thought-process dialog below.
  const { openAttachment, attachmentViewer } = useAttachmentViewer(token)
  // Same ownership seam as the thought-process dialog: the popup and its
  // minimized chips live with the feed, so the channel and the reply panel get
  // them from one implementation.
  const { chips: documentChips, dialog: documentDialog } = useDocumentStreamDialog(
    documentSessions ?? EMPTY_DOCUMENT_SESSIONS,
    documentStore ?? emptyDocumentStore,
    threadId,
  )
  const { openThoughtProcess, thoughtProcessDialog } = useThoughtProcessDialog(
    pendingMessages,
    resolveAgentIdentity,
    threadId,
    token,
  )
  // Thread-anchored runs render under the message their reply will hang from;
  // only the channel feed shows those, since a reply panel is already scoped.
  const pendingByRoot = useMemo(
    () =>
      thinkingSurface === 'channel'
        ? groupPendingByRoot(pendingMessages)
        : new Map<string, PendingStreamMessage[]>(),
    [pendingMessages, thinkingSurface],
  )
  // Everything at the bottom of this surface is a reply that will land at the
  // bottom of this surface: a reply panel owns every run it was handed, the
  // channel feed only the top-level ones. A thread-anchored run's live surface
  // in the channel is the compact bubble under its root — its reply text
  // streams where the reply will actually land (the thread panel), never at
  // the bottom of the main window.
  const bottomPendingEntries = useMemo(
    () =>
      thinkingSurface === 'thread'
        ? pendingMessages
        : pendingMessages.filter((entry) => entry.rootMessageId == null),
    [pendingMessages, thinkingSurface],
  )
  const renderThinkingBubble = (
    entry: PendingStreamMessage,
    variant: 'compact' | 'full',
  ) => {
    const identity = resolveAgentIdentity(entry.agentId)
    return (
      <ThinkingBubble
        agent={identity.agent}
        agentName={identity.name}
        entry={entry}
        key={`thinking:${entry.runId}`}
        token={token}
        variant={variant}
        onOpen={openThoughtProcess}
      />
    )
  }
  const resolveReactorName = useResolveReactorName({
    agentById,
    agentMap,
    assistantFallbackName,
    channelUsers,
    feedItems,
    meUserId,
    personalAssistantPresenceByIdentity,
  })
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
    <div className="admin-chat-feed" data-message-feed>
      {feedItems.length === 0 &&
      pendingMessages.length === 0 &&
      optimisticMessages.length === 0 ? (
        emptyState ?? (
          <div className="p-5">
            <div className="admin-card p-4 text-sm text-[color:var(--tx3)]">
              No messages yet. Send the first message to start this thread.
            </div>
          </div>
        )
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

        const anchoredThinking = pendingByRoot.get(item.message.id) ?? []
        const personalAssistantPresence =
          item.message.agentId && item.message.onBehalfOfUserId
            ? personalAssistantPresenceByIdentity.get(personalAssistantPresenceKey(
                item.message.agentId,
                item.message.onBehalfOfUserId,
              )) ?? null
            : null

        return (
          <Fragment key={item.message.id}>
            <ChannelMessageRow
              activeActionMessageId={activeActionMessageId}
              agentMap={agentMap}
              assistantFallbackName={assistantFallbackName}
              editingContent={editingContent}
              editingMessageId={editingMessageId}
              getPresence={getPresence}
              isDedicatedAgentConversation={isDedicatedAgentConversation}
              isExternalAgentConversation={isExternalAgentConversation}
              lastPointerDownAt={lastPointerDownAt}
              meAvatar={meAvatar}
              meDisplayName={meDisplayName}
              meUserId={meUserId}
              message={item.message}
              personalAssistantPresence={personalAssistantPresence}
              renderContent={renderContent}
              resolveReactorName={resolveReactorName}
              setActiveActionMessageId={setActiveActionMessageId}
              token={token}
              updatePending={updatePending}
              onAddReaction={onAddReaction}
              onCancelEdit={onCancelEdit}
              onChangeEditingContent={onChangeEditingContent}
              onConfirmDelete={onConfirmDelete}
              onOpenAttachment={openAttachment}
              onOpenThread={onOpenThread}
              onSelectAgent={onSelectAgent}
              onSelectUser={onSelectUser}
              onStartEdit={onStartEdit}
              shareRestrictedMessage={shareRestrictedMessage}
              onSubmitEdit={onSubmitEdit}
              resolveThreadParticipant={resolveThreadParticipant}
            />
            {anchoredThinking.map((entry) => renderThinkingBubble(entry, 'compact'))}
          </Fragment>
        )
      })}

      {optimisticMessages.map((entry) => (
        <OptimisticMessageRow
          entry={entry}
          getPresence={getPresence}
          key={entry.clientId}
          meAvatar={meAvatar}
          meDisplayName={meDisplayName}
          meUserId={meUserId}
          renderContent={renderContent}
          token={token}
        />
      ))}

      {bottomPendingEntries.length > 0 ? (
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

      {bottomPendingEntries.map((entry) => {
        const { agent: pendingAgent, name: pendingDisplayName } = resolveAgentIdentity(
          entry.agentId,
        )
        // A bubble directly above already says the agent is thinking, so the
        // streaming row waits for actual reply text instead of repeating it.
        const showStreamingRow = entry.content.length > 0

        return (
          <Fragment key={entry.runId}>
            {renderThinkingBubble(entry, 'full')}
            {showStreamingRow ? (
              <StreamingMessageRow
                agent={pendingAgent}
                displayName={pendingDisplayName}
                entry={entry}
                isDedicatedAgentConversation={isDedicatedAgentConversation}
                renderContent={renderContent}
                token={token}
              />
            ) : null}
          </Fragment>
        )
      })}
      {/*
        The ambient line, last so it sits directly under the newest row. It is
        anonymous by design — no avatar, no agent name — because no run exists
        yet and the engagement decision may still decline.
      */}
      {showLivenessHint ? (
        <div
          aria-label="Waiting for a reply"
          className="flex items-center py-1 pl-12 pr-5"
          data-testid="liveness-hint"
          role="status"
        >
          <span aria-hidden="true" className="liveness-dots">
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : null}

      {documentChips}

      {attachmentViewer}
      {documentDialog}
      {thoughtProcessDialog}
      <div className="h-3" />
    </div>
  )
}
