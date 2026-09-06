import { useCallback, useMemo, type FormEvent, type ReactNode } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type {
  AgentRecord,
  ChannelRecord,
  PersonalAssistantPresenceParticipant,
  ThreadMessageRecord,
} from '../../../lib/api-client'
import type { PendingStreamMessage } from '../../../facades/threads/thinking'
import { OversizePasteDialog } from '../../shared/OversizePasteDialog'
import { Sheet } from '../../overlays/Sheet'
import type { MentionEntity } from '../../shared/MentionInput'
import { ChannelAgentGlyph } from './ChannelAgentGlyph'
import { ChannelComposer } from './ChannelComposer'
import {
  ChannelMessageFeed,
  type MessageHistoryStatus,
} from './ChannelMessageFeed'
import { buildFeedItems } from './channel-feed'
import { type ChannelAgentParticipant } from './channel-participants'
import {
  useStickToBottom,
  type OlderContentLoader,
} from '../../../hooks/useStickToBottom'
import { channelComposerDraftKey } from './composer-draft'
import { useChannelComposer } from './useChannelComposer'
import { useChannelMessageActions } from './useChannelMessageActions'
import type { AvatarSources } from '../../shared/UserAvatar'

type ChannelAgentInfoDrawerProps = {
  activeChannel: ChannelRecord | null
  agent: ChannelAgentParticipant | null
  agents: AgentRecord[]
  meAvatar: AvatarSources
  meDisplayName: string
  meUserId: string
  mentionEntities: MentionEntity[]
  onClose: () => void
  onOpenActivity: (agentId: string) => void
  pendingMessages: PendingStreamMessage[]
  renderContent: (text: string) => ReactNode
  threadMessages: ThreadMessageRecord[]
  threadMessageHistory: MessageHistoryStatus
  threadMessageLoader: OlderContentLoader
  token: string | null
}

const mentionBoundaryAfter = /[\s.,!?;:()[\]{}\u00A0]/

const includesAgentMention = (text: string, agentName: string): boolean => {
  const marker = `@${agentName}`.toLowerCase()
  const lowerText = text.toLowerCase()
  let index = lowerText.indexOf(marker)

  while (index !== -1) {
    const next = text[index + marker.length]
    if (next === undefined || mentionBoundaryAfter.test(next)) {
      return true
    }
    index = lowerText.indexOf(marker, index + marker.length)
  }

  return false
}

const mentionsAgent = (message: ThreadMessageRecord, agent: AgentRecord): boolean => {
  const mentions =
    message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata) &&
    'mentions' in message.metadata
      ? message.metadata.mentions
      : null
  const agentIds =
    mentions &&
    typeof mentions === 'object' &&
    !Array.isArray(mentions) &&
    'agentIds' in mentions &&
    Array.isArray(mentions.agentIds)
      ? mentions.agentIds
      : []

  return agentIds.includes(agent.id) || includesAgentMention(message.content, agent.name)
}

const buildAddressedMessage = (rawText: string, agent: AgentRecord): string => {
  const text = rawText.trim()
  if (!text || includesAgentMention(text, agent.name)) {
    return text
  }
  return `@${agent.name} ${text}`
}

const channelLabel = (channel: ChannelRecord): string =>
  channel.type === 'dm' ? channel.label : `#${channel.label}`

const isPersonalAssistantPresence = (
  participant: ChannelAgentParticipant,
): participant is PersonalAssistantPresenceParticipant =>
  'isPersonalAssistant' in participant

export const ChannelAgentInfoDrawer = ({
  activeChannel,
  agent,
  agents,
  meAvatar,
  meDisplayName,
  meUserId,
  mentionEntities,
  onClose,
  onOpenActivity,
  pendingMessages,
  renderContent,
  threadMessages,
  threadMessageHistory,
  threadMessageLoader,
  token,
}: ChannelAgentInfoDrawerProps) => {
  const {
    message,
    setMessage,
    optimisticMessages,
    oversizePaste,
    setOversizePaste,
    mentionRef,
    isSendPending,
    sendError,
    attachments,
    insertEmoji,
    sendText,
    sendAsFile,
    pendingAgentInvites,
    invitingAgentId,
    inviteErrors,
    invitePendingAgent,
    dismissPendingAgent,
    confirmSecretCapture,
    dismissSecretCapture,
    secretCapture,
  } = useChannelComposer({
    activeChannel,
    currentUserId: meUserId,
    draftKey: channelComposerDraftKey(activeChannel?.id),
    threadMessages,
  })
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
  } = useChannelMessageActions(activeChannel?.defaultThreadId)

  const agentMap = useMemo(
    () => new Map(agents.map((entry) => [entry.id, entry])),
    [agents],
  )
  const selectedAgentRecord = agent && !isPersonalAssistantPresence(agent) ? agent : null
  const agentMessages = useMemo(
    () =>
      selectedAgentRecord
        ? threadMessages.filter(
            (entry) =>
              entry.agentId === selectedAgentRecord.id ||
              (entry.role === 'user' && mentionsAgent(entry, selectedAgentRecord)),
          )
        : [],
    [selectedAgentRecord, threadMessages],
  )
  const agentPendingMessages = useMemo(
    () => selectedAgentRecord
      ? pendingMessages.filter((entry) => entry.agentId === selectedAgentRecord.id)
      : [],
    [selectedAgentRecord, pendingMessages],
  )
  const feedItems = useMemo(() => buildFeedItems(agentMessages), [agentMessages])

  const sendAddressedText = useCallback(
    async (rawText: string) => {
      if (!selectedAgentRecord) {
        return
      }
      await sendText(buildAddressedMessage(rawText, selectedAgentRecord))
    },
    [selectedAgentRecord, sendText],
  )

  const sendAddressedForm = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      const text = mentionRef.current?.getText() ?? message
      mentionRef.current?.clear()
      await sendAddressedText(text)
    },
    [mentionRef, message, sendAddressedText],
  )

  // Same stick-to-bottom behaviour as the channel feed: opens on the newest
  // message and follows rows that keep growing (media, thinking tickers).
  const drawerScroll = useStickToBottom(agent?.id, true, threadMessageLoader)

  if (!agent || !activeChannel) {
    return null
  }

  if (isPersonalAssistantPresence(agent)) {
    const assistantAvatar = {
      avatarAttachmentId: agent.avatarAttachmentId,
      id: agent.agentId,
      name: agent.displayName,
      role: 'Personal Assistant',
    }
    return (
      <Sheet
        onClose={onClose}
        open
        side="right"
        size="md"
        title={`${agent.displayName} participant`}
      >
        <div
          className={[
            'admin-chat-surface flex h-full w-full min-h-0 flex-col',
            'border-l border-[color:var(--sep)] bg-[color:var(--main)]',
            'shadow-[0_32px_80px_var(--scrim-strong)]',
          ].join(' ')}
        >
          <header className="flex items-start justify-between gap-3 border-b border-[color:var(--sep)] px-5 pb-4 pt-5">
            <div className="flex min-w-0 items-center gap-3">
              <ChannelAgentGlyph agent={assistantAvatar} size="lg" token={token} />
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-[var(--tx)]">
                  {agent.displayName}
                </h2>
                <div className="text-xs text-[color:var(--tx3)]">Personal Assistant</div>
              </div>
            </div>
            <button
              className="admin-button admin-button-secondary h-9"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </header>
          <div className="p-5 text-sm leading-6 text-[color:var(--tx2)]">
            This assistant is present in this channel. Its settings, tools, and activity
            remain private to its owner.
          </div>
        </div>
      </Sheet>
    )
  }

  const providerModel = [agent.provider, agent.model].filter(Boolean).join(' / ')

  return (
    <>
      <Sheet onClose={onClose} open side="right" size="md" title={`${agent.name} info`}>
        <div
          className={[
            'admin-chat-surface flex h-full w-full min-h-0 flex-col',
            'border-l border-[color:var(--sep)] bg-[color:var(--main)]',
            'shadow-[0_32px_80px_var(--scrim-strong)]',
          ].join(' ')}
        >
          <header className="flex-shrink-0 border-b border-[color:var(--sep)] px-5 pb-4 pt-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <ChannelAgentGlyph agent={agent} size="lg" token={token} />
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold text-[var(--tx)]">
                    {agent.name}
                  </h2>
                  <div className="truncate text-xs text-[color:var(--tx3)]">
                    {agent.role}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                    {/* Not a `Pill`: this chip inherits the row's text-[11px], and
                        `Pill` has no size that leaves the font size to the parent —
                        size="sm" would pin it to 10px while the provider/model span
                        beside it stays at 11px. */}
                    <span className="rounded bg-[var(--overlay-weak)] px-1.5 py-0.5 uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                      {agent.status}
                    </span>
                    {providerModel ? (
                      <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[var(--thinking)]">
                        {providerModel}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <button
                className="admin-button admin-button-secondary h-9"
                onClick={onClose}
                type="button"
              >
                Close
              </button>
            </div>
            {agent.systemPrompt ? (
              <p className="mt-4 line-clamp-3 text-xs leading-5 text-[color:var(--tx2)]">
                {agent.systemPrompt}
              </p>
            ) : null}
            <button
              className="admin-button admin-button-secondary admin-button-compact mt-4 h-8"
              onClick={() => onOpenActivity(agent.id)}
              type="button"
            >
              Open activity
            </button>
          </header>

          <div
            className="min-h-0 flex-1 overflow-y-auto py-2"
            data-testid="agent-info-drawer-messages"
            ref={drawerScroll.containerRef}
          >
            <div ref={drawerScroll.contentRef}>
              <ChannelMessageFeed
                agentById={agentMap}
                agentMap={agentMap}
                editingContent={editingContent}
                editingMessageId={editingMessageId}
                feedItems={feedItems}
                historyStatus={{
                  ...threadMessageHistory,
                  retryOlder: drawerScroll.loadOlder,
                }}
                isPersonalAssistantConversation={false}
                meAvatar={meAvatar}
                meDisplayName={meDisplayName}
                meUserId={meUserId}
                optimisticMessages={optimisticMessages}
                pendingMessages={agentPendingMessages}
                renderContent={renderContent}
                threadId={activeChannel.defaultThreadId}
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

          <ChannelComposer
            attachments={attachments}
            isSendPending={isSendPending}
            sendError={sendError}
            mentionEntities={mentionEntities}
            mentionRef={mentionRef}
            message={message}
            placeholder={`Message @${agent.name} in ${channelLabel(activeChannel)}`}
            onChangeMessage={setMessage}
            onInsertAtSign={() => mentionRef.current?.insertAtSign()}
            onInsertEmoji={insertEmoji}
            onInsertHashSign={() => mentionRef.current?.insertHashSign()}
            onOversizePaste={(paste) => setOversizePaste(paste)}
            onConfirmSecretCapture={confirmSecretCapture}
            onDismissSecretCapture={dismissSecretCapture}
            onSubmitForm={(event) => {
              drawerScroll.pinToBottom()
              void sendAddressedForm(event)
            }}
            onSubmitText={(text) => {
              drawerScroll.pinToBottom()
              void sendAddressedText(text)
            }}
            pendingAgentInvites={pendingAgentInvites}
            invitingAgentId={invitingAgentId}
            inviteErrors={inviteErrors}
            onInvitePendingAgent={(agentId) => void invitePendingAgent(agentId)}
            onDismissPendingAgent={dismissPendingAgent}
            secretCapture={secretCapture}
          />
        </div>
      </Sheet>

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
