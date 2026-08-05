import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../../../lib/api-client'
import {
  countThinkingEntries,
  type PendingStreamMessage,
} from '../../../../facades/threads/thinking'
import type { useReplyThread } from '../../../../pages/channels/useReplyThread'
import { OversizePasteDialog } from '../../../shared/OversizePasteDialog'
import type { MentionEntity } from '../../../shared/MentionInput'
import type { AvatarSources } from '../../../primitives/UserAvatar'
import { ChannelComposer } from '../ChannelComposer'
import { ChannelMessageFeed } from '../ChannelMessageFeed'
import { buildFeedItems } from '../channel-helpers'
import { useChannelComposer } from '../useChannelComposer'
import { useChannelMessageActions } from '../useChannelMessageActions'

interface ThreadReplyPanelProps {
  activeChannel: ChannelRecord
  agentMap: Map<string, AgentRecord>
  channelUsers: UserRecord[]
  // The panel inherits the page's conversation kind so agent naming (e.g. the
  // Personal Assistant fallback) matches the main feed.
  isPersonalAssistantConversation: boolean
  isExternalAgentConversation: boolean
  meAvatar: AvatarSources
  meDisplayName: string
  meUserId: string
  mentionEntities: MentionEntity[]
  // Live agent runs whose reply will land in THIS reply thread — the page
  // filters the thread stream by anchor before handing them down.
  pendingMessages: PendingStreamMessage[]
  renderContent: (text: string) => ReactNode
  thread: ReturnType<typeof useReplyThread>
  token: string | null
}

const channelLabel = (channel: ChannelRecord): string =>
  channel.type === 'dm' ? channel.label : `#${channel.label}`

// Right-hand reply-thread panel (#233): one component whose classes adapt at
// the breakpoints — in-flow third pane at >=1280px (drag-resizable via the
// left-edge separator), fixed overlay with scrim at 900–1279px, full-screen
// below 900px. The width comes from a CSS variable so the inline style never
// fights the full-screen class.
export const ThreadReplyPanel = ({
  activeChannel,
  agentMap,
  channelUsers,
  isPersonalAssistantConversation,
  isExternalAgentConversation,
  meAvatar,
  meDisplayName,
  meUserId,
  mentionEntities,
  pendingMessages,
  renderContent,
  thread,
  token,
}: ThreadReplyPanelProps) => {
  const {
    activeThreadId,
    closeThread,
    followMutation,
    openRootMessageId,
    panelWidth,
    repliesQuery,
    resizePanel,
    rootQuery,
  } = thread
  const root = rootQuery.data?.message ?? null
  const viewerFollowing = rootQuery.data?.viewerFollowing ?? false
  const replies = useMemo(() => repliesQuery.data ?? [], [repliesQuery.data])
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanup.current?.(), [])

  const getSendExtras = useCallback(
    () => ({ alsoSendToChannel, rootMessageId: openRootMessageId ?? undefined }),
    [alsoSendToChannel, openRootMessageId],
  )
  const {
    message,
    setMessage,
    optimisticMessages,
    oversizePaste,
    setOversizePaste,
    mentionRef,
    isSendPending,
    sendText,
    sendMessageSubmit,
    sendAsFile,
    pendingAgentInvites,
    invitingAgentId,
    inviteErrors,
    invitePendingAgent,
    dismissPendingAgent,
  } = useChannelComposer({
    activeChannel,
    threadMessages: replies,
    currentUserId: meUserId,
    getSendExtras,
  })
  const {
    addReaction,
    cancelEdit,
    changeEditingContent,
    confirmDelete,
    editingContent,
    editingMessageId,
    startEdit,
    submitEdit,
    updatePending,
  } = useChannelMessageActions(activeThreadId)

  // Escape closes the panel — except while typing in the composer, where
  // Escape belongs to the input/mention menu.
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) {
        return
      }
      closeThread()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeThread])

  // Render the root and replies as one continuous conversation. Rendering them
  // as separate feeds created a reply-count separator directly above the date
  // separator, even for a simple one-message reply.
  const threadFeedItems = useMemo(
    () => (root ? buildFeedItems([root, ...replies]) : []),
    [replies, root],
  )

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
    // A growing thinking bubble changes the list height like a new reply does.
  }, [
    openRootMessageId,
    threadFeedItems.length,
    optimisticMessages.length,
    pendingMessages.length,
    countThinkingEntries(pendingMessages),
  ])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panelWidth

    const move = (moveEvent: PointerEvent) => {
      resizePanel(startWidth + (startX - moveEvent.clientX))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      resizeCleanup.current = null
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    resizeCleanup.current = stop
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const rootDeleted = Boolean(root?.deletedAt)

  return (
    <>
      <button
        aria-label="Close thread"
        className="fixed inset-0 z-40 hidden bg-[var(--scrim-strong)] min-[900px]:max-[1279px]:block"
        onClick={closeThread}
        type="button"
      />
      <aside
        aria-label="Thread"
        className={[
          'z-50 flex w-full flex-col border-l border-[color:var(--sep)] bg-[color:var(--main)]',
          'max-[899px]:fixed max-[899px]:inset-0',
          'min-[900px]:w-[var(--thread-panel-width)]',
          'min-[900px]:max-[1279px]:fixed min-[900px]:max-[1279px]:inset-y-0 min-[900px]:max-[1279px]:right-0',
          'min-[900px]:max-[1279px]:shadow-[0_32px_80px_var(--scrim-strong)]',
          'min-[1280px]:relative min-[1280px]:z-auto min-[1280px]:h-full min-[1280px]:shrink-0',
        ].join(' ')}
        style={{ '--thread-panel-width': `${panelWidth}px` } as CSSProperties}
      >
        <div
          aria-label="Resize thread panel"
          aria-orientation="vertical"
          aria-valuemax={Math.floor(window.innerWidth / 2)}
          aria-valuemin={320}
          aria-valuenow={panelWidth}
          className={[
            'absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize touch-none',
            'hover:bg-[var(--accent-soft)] min-[1280px]:block',
          ].join(' ')}
          onPointerDown={startResize}
          role="separator"
        />
        <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[color:var(--sep)] px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--tx)]">Thread</h2>
            <div className="truncate text-xs text-[color:var(--tx3)]">
              {channelLabel(activeChannel)}
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              className="admin-button admin-button-secondary h-8 px-3 text-xs"
              disabled={!root || followMutation.isPending}
              onClick={() => followMutation.mutate(!viewerFollowing)}
              type="button"
            >
              {viewerFollowing ? 'Unfollow' : 'Follow'}
            </button>
            <button
              aria-label="Close thread"
              className="admin-button admin-button-secondary h-8 w-8 px-0 text-sm"
              onClick={closeThread}
              type="button"
            >
              ×
            </button>
          </div>
        </header>

        {rootQuery.isLoading ? (
          <div className="p-5 text-sm text-[color:var(--tx3)]">Loading thread…</div>
        ) : rootQuery.isError || !root ? (
          <div className="flex flex-col items-start gap-3 p-5">
            <p className="text-sm text-[color:var(--tx2)]">
              This thread could not be loaded. It may have been removed.
            </p>
            <button
              className="admin-button admin-button-secondary h-8 px-3 text-xs"
              onClick={closeThread}
              type="button"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div
              className="min-h-0 flex-1 overflow-y-auto"
              data-testid="thread-panel-replies"
              ref={scrollRef}
            >
              {rootDeleted ? (
                <div className="mx-4 mt-3 rounded-lg border border-dashed border-[color:var(--sep)] px-3 py-2 text-xs text-[color:var(--tx3)]">
                  The root message was deleted. Replies are turned off.
                </div>
              ) : null}
              <ChannelMessageFeed
                agentById={agentMap}
                agentMap={agentMap}
                channelUsers={channelUsers}
                editingContent={editingContent}
                editingMessageId={editingMessageId}
                feedItems={threadFeedItems}
                isExternalAgentConversation={isExternalAgentConversation}
                isPersonalAssistantConversation={isPersonalAssistantConversation}
                meAvatar={meAvatar}
                meDisplayName={meDisplayName}
                meUserId={meUserId}
                optimisticMessages={optimisticMessages}
                pendingMessages={pendingMessages}
                renderContent={renderContent}
                thinkingSurface="thread"
                threadId={activeThreadId}
                token={token}
                updatePending={updatePending}
                onAddReaction={addReaction}
                onCancelEdit={cancelEdit}
                onChangeEditingContent={changeEditingContent}
                onConfirmDelete={confirmDelete}
                onStartEdit={startEdit}
                onSubmitEdit={(messageId) => void submitEdit(messageId)}
              />
            </div>

            {rootDeleted ? (
              <div className="flex-shrink-0 px-5 pb-[14px] text-xs text-[color:var(--tx3)]">
                You can’t reply to a deleted message.
              </div>
            ) : (
              <>
                <label className="flex flex-shrink-0 items-center gap-2 px-5 pb-1 text-xs text-[color:var(--tx2)]">
                  <input
                    checked={alsoSendToChannel}
                    className="accent-[var(--accent)]"
                    onChange={(event) => setAlsoSendToChannel(event.target.checked)}
                    type="checkbox"
                  />
                  Also send to {channelLabel(activeChannel)}
                </label>
                <ChannelComposer
                  isSendPending={isSendPending}
                  mentionEntities={mentionEntities}
                  mentionRef={mentionRef}
                  message={message}
                  placeholder="Reply to thread"
                  onChangeMessage={setMessage}
                  onInsertAtSign={() => mentionRef.current?.insertAtSign()}
                  onInsertHashSign={() => mentionRef.current?.insertHashSign()}
                  onOversizePaste={(paste) => setOversizePaste(paste)}
                  onSubmitForm={(event) => void sendMessageSubmit(event)}
                  onSubmitText={(text) => void sendText(text)}
                  pendingAgentInvites={pendingAgentInvites}
                  invitingAgentId={invitingAgentId}
                  inviteErrors={inviteErrors}
                  onInvitePendingAgent={(agentId) => void invitePendingAgent(agentId)}
                  onDismissPendingAgent={dismissPendingAgent}
                />
              </>
            )}
          </>
        )}
      </aside>

      <OversizePasteDialog
        limit={CHAT_MESSAGE_MAX_CHARS}
        onCancel={() => setOversizePaste(null)}
        onInsertTrimmed={(trimmed) => {
          setOversizePaste(null)
          mentionRef.current?.insertText(trimmed)
        }}
        onSendAsFile={(text) => sendAsFile(text)}
        open={oversizePaste !== null}
        pastedText={oversizePaste ?? ''}
      />
    </>
  )
}
