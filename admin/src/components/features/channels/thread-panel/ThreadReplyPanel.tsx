import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../../../lib/api-client'
import type { PendingStreamMessage } from '../../../../facades/threads/thinking'
import type { useReplyThread } from '../../../../pages/channels/useReplyThread'
import { useFileDrop } from '../../../../hooks/useFileDrop'
import { useStickToBottom } from '../../../../hooks/useStickToBottom'
import { DropZoneOverlay } from '../../../shared/DropZoneOverlay'
import { OversizePasteDialog } from '../../../shared/OversizePasteDialog'
import type { MentionEntity } from '../../../shared/MentionInput'
import type { AvatarSources } from '../../../primitives/UserAvatar'
import { THREAD_PANEL_MIN_WIDTH } from './thread-panel-helpers'
import { usePhoneLayout } from '../../../../lib/mobile-shell'
import { PhoneBackButton } from '../../../../layouts/admin-shell/PhoneBackButton'
import { ChannelComposer } from '../ChannelComposer'
import { ChannelMessageFeed } from '../ChannelMessageFeed'
import { buildFeedItems } from '../channel-helpers'
import { useAgentLivenessHint } from '../useAgentLivenessHint'
import { useChannelComposer } from '../useChannelComposer'
import { useChannelMessageActions } from '../useChannelMessageActions'

interface ThreadReplyPanelProps {
  activeChannel: ChannelRecord
  agentMap: Map<string, AgentRecord>
  channelUsers: UserRecord[]
  // Structural fact from the page: the channel has at least one agent that
  // could pick a reply up, so the ambient liveness hint is worth showing.
  hasRespondingAgent: boolean
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

// One arrow-key press on the thread separator steps the width by this much;
// Home/End jump to the widest/narrowest allowed widths.
const KEYBOARD_RESIZE_STEP = 16

const channelLabel = (channel: ChannelRecord): string =>
  channel.type === 'dm' ? channel.label : `#${channel.label}`

const BackArrow = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="18"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="18"
  >
    <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// Right-hand reply-thread panel (#233): one component whose classes adapt at
// the breakpoints — in-flow third pane at >=1280px (drag-resizable via the
// left-edge separator), fixed overlay with scrim at 900–1279px, full-screen
// below 900px. The width comes from a CSS variable so the inline style never
// fights the full-screen class.
export const ThreadReplyPanel = ({
  activeChannel,
  agentMap,
  channelUsers,
  hasRespondingAgent,
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
  const phoneLayout = usePhoneLayout()
  const {
    activeThreadId,
    closeThread,
    openRootMessageId,
    panelWidth,
    persistPanelWidth,
    repliesQuery,
    resizePanel,
    resizePanelWithKeyboard,
    rootQuery,
    viewportWidth,
  } = thread
  const root = rootQuery.data?.message ?? null
  const replies = useMemo(() => repliesQuery.data ?? [], [repliesQuery.data])
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false)
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
    attachments,
    insertEmoji,
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
  // The panel is its own drop target in every responsive mode (in-flow pane,
  // overlay, full screen) — files land on the reply composer, not the channel.
  // Disabled while there is no composer to stage them in.
  const replyDrop = useFileDrop(attachments.addFiles, !root || Boolean(root.deletedAt))
  const {
    addReaction,
    cancelEdit,
    changeEditingContent,
    confirmDelete,
    deleteConfirm,
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
  const threadMessages = useMemo(
    () => (root ? [root, ...replies] : []),
    [replies, root],
  )
  const threadFeedItems = useMemo(() => buildFeedItems(threadMessages), [threadMessages])
  // Same ambient hint as the channel feed, scoped to this reply thread: the
  // page already filtered `pendingMessages` to runs replying here, so a bubble
  // in this panel hides the hint instead of stacking with it.
  const liveness = useAgentLivenessHint({
    hasRespondingAgent,
    meUserId,
    messages: threadMessages,
    pendingMessages,
    surfaceKey: openRootMessageId ?? undefined,
  })
  const markReplySent = liveness.markSent

  // Same stick-to-bottom behaviour as the channel feed: the panel opens on the
  // newest reply and follows growing rows until the reader scrolls up.
  const threadScroll = useStickToBottom(openRootMessageId)

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panelWidth
    let cancelled = false

    // Coalesce each burst of pointermoves into one resize per frame, and
    // write localStorage once at interaction end instead of per move.
    let frame: number | undefined
    let pendingClientX: number | null = null
    const flush = () => {
      frame = undefined
      if (pendingClientX === null) return
      const clientX = pendingClientX
      pendingClientX = null
      resizePanel(startWidth + (startX - clientX))
    }
    const move = (moveEvent: PointerEvent) => {
      pendingClientX = moveEvent.clientX
      if (frame === undefined) frame = requestAnimationFrame(flush)
    }
    // Runs for every termination — pointerup, pointercancel, window blur,
    // unmount mid-drag — so the body cursor/userSelect can never stick.
    // A cancel drops the pending frame and keeps the last applied width.
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (!cancelled) flush()
      persistPanelWidth()
      resizeCleanup.current = null
    }
    const cancel = () => {
      cancelled = true
      stop()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    resizeCleanup.current = cancel
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // The separator exposes an ARIA separator role, so it owes the same
  // keyboard path the sidebar separator has: arrows step, Home/End jump.
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null
    if (event.key === 'ArrowLeft') nextWidth = panelWidth + KEYBOARD_RESIZE_STEP
    if (event.key === 'ArrowRight') nextWidth = panelWidth - KEYBOARD_RESIZE_STEP
    if (event.key === 'Home') nextWidth = viewportWidth / 2
    if (event.key === 'End') nextWidth = THREAD_PANEL_MIN_WIDTH
    if (nextWidth === null) return

    event.preventDefault()
    resizePanelWithKeyboard(nextWidth)
  }

  const rootDeleted = Boolean(root?.deletedAt)

  return (
    <>
      <button
        aria-label="Back to channel"
        className="fixed inset-0 z-40 hidden bg-[var(--scrim-strong)] min-[900px]:max-xl:block"
        onClick={closeThread}
        type="button"
      />
      <aside
        aria-label="Thread"
        className={[
          'admin-chat-surface z-50 flex w-full flex-col border-l border-[color:var(--sep)] bg-[color:var(--main)]',
          // The regular admin columns receive the status-bar inset from the
          // WebView bridge. This fixed overlay sits outside those columns, so
          // it owns the inset itself and keeps its header controls out from
          // under an iOS notch in both phone and tablet overlay modes.
          'max-[900px]:fixed max-[900px]:inset-0 max-xl:pt-[env(safe-area-inset-top,0px)]',
          'min-[900px]:w-[var(--thread-panel-width)]',
          'min-[900px]:max-xl:fixed min-[900px]:max-xl:inset-y-0 min-[900px]:max-xl:right-0',
          'min-[900px]:max-xl:shadow-[0_32px_80px_var(--scrim-strong)]',
          'xl:relative xl:z-auto xl:h-full xl:shrink-0',
        ].join(' ')}
        style={{ '--thread-panel-width': `${panelWidth}px` } as CSSProperties}
        {...replyDrop.dropHandlers}
      >
        <div
          aria-label="Resize thread panel"
          aria-orientation="vertical"
          aria-valuemax={Math.floor(Math.max(viewportWidth / 2, THREAD_PANEL_MIN_WIDTH))}
          aria-valuemin={THREAD_PANEL_MIN_WIDTH}
          aria-valuenow={panelWidth}
          className={[
            'absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize touch-none',
            'hover:bg-[var(--accent-soft)] focus-visible:bg-[var(--accent-soft)] xl:block',
          ].join(' ')}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize}
          role="separator"
          tabIndex={0}
        />
        <header className="flex flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4 py-3">
          {phoneLayout ? (
            // The route-level control sits behind this full-screen overlay, so
            // the thread itself owns the shared phone Back doorway.
            <PhoneBackButton label="Back to channel" onBack={closeThread} />
          ) : (
            <button
              aria-label="Back to channel"
              className="admin-button admin-button-secondary flex h-8 w-8 shrink-0 items-center justify-center px-0"
              onClick={closeThread}
              title="Back to channel"
              type="button"
            >
              <BackArrow />
            </button>
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--tx)]">Thread</h2>
            <div className="truncate text-xs text-[color:var(--tx3)]">
              {channelLabel(activeChannel)}
            </div>
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
              Back to channel
            </button>
          </div>
        ) : (
          <>
            <div
              className="min-h-0 flex-1 overflow-y-auto"
              data-testid="thread-panel-replies"
              ref={threadScroll.containerRef}
            >
              <div ref={threadScroll.contentRef}>
                {rootDeleted ? (
                  <div className="mx-4 mt-3 rounded-lg border border-dashed border-[color:var(--sep)] px-3 py-2 text-xs text-[color:var(--tx3)]">
                    The root message was deleted. Replies are turned off.
                  </div>
                ) : null}
                <ChannelMessageFeed
                  agentById={agentMap}
                  agentMap={agentMap}
                  channelUsers={channelUsers}
                  personalAssistantPresences={activeChannel.personalAssistantPresences}
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
                  showLivenessHint={liveness.visible}
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
                  attachments={attachments}
                  isSendPending={isSendPending}
                  mentionEntities={mentionEntities}
                  mentionRef={mentionRef}
                  message={message}
                  placeholder="Reply to thread"
                  onChangeMessage={setMessage}
                  onInsertAtSign={() => mentionRef.current?.insertAtSign()}
                  onInsertEmoji={insertEmoji}
                  onInsertHashSign={() => mentionRef.current?.insertHashSign()}
                  onOversizePaste={(paste) => setOversizePaste(paste)}
                  onSubmitForm={(event) => {
                    threadScroll.pinToBottom()
                    markReplySent()
                    void sendMessageSubmit(event)
                  }}
                  onSubmitText={(text, agentMentions) => {
                    threadScroll.pinToBottom()
                    markReplySent()
                    void sendText(text, agentMentions)
                  }}
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

        <DropZoneOverlay active={replyDrop.isDragging} label="Drop files to reply with" />
      </aside>

      {deleteConfirm}

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
