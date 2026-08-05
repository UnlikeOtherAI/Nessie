import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type FormEvent,
  type ReactNode,
} from 'react'
import { countThinkingEntries } from '../../../facades/threads/thinking'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type { AgentRecord, ChannelRecord, ThreadMessageRecord } from '../../../lib/api-client'
import type { PendingStreamMessage } from '../../../facades/threads/thinking'
import { OversizePasteDialog } from '../../shared/OversizePasteDialog'
import type { MentionEntity } from '../../shared/MentionInput'
import { ChannelAgentGlyph } from './ChannelAgentGlyph'
import { ChannelComposer } from './ChannelComposer'
import { ChannelMessageFeed } from './ChannelMessageFeed'
import { buildFeedItems } from './channel-helpers'
import { useChannelComposer } from './useChannelComposer'
import { useChannelMessageActions } from './useChannelMessageActions'
import type { AvatarSources } from '../../primitives/UserAvatar'

type ChannelAgentInfoDrawerProps = {
  activeChannel: ChannelRecord | null
  agent: AgentRecord | null
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
  token,
}: ChannelAgentInfoDrawerProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const {
    message,
    setMessage,
    optimisticMessages,
    oversizePaste,
    setOversizePaste,
    mentionRef,
    isSendPending,
    sendText,
    sendAsFile,
    pendingAgentInvites,
    invitingAgentId,
    inviteErrors,
    invitePendingAgent,
    dismissPendingAgent,
  } = useChannelComposer({
    activeChannel,
    currentUserId: meUserId,
    threadMessages,
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
  } = useChannelMessageActions(activeChannel?.defaultThreadId)

  const agentMap = useMemo(
    () => new Map(agents.map((entry) => [entry.id, entry])),
    [agents],
  )
  const agentMessages = useMemo(
    () =>
      agent
        ? threadMessages.filter(
            (entry) =>
              entry.agentId === agent.id ||
              (entry.role === 'user' && mentionsAgent(entry, agent)),
          )
        : [],
    [agent, threadMessages],
  )
  const agentPendingMessages = useMemo(
    () => (agent ? pendingMessages.filter((entry) => entry.agentId === agent.id) : []),
    [agent, pendingMessages],
  )
  const feedItems = useMemo(() => buildFeedItems(agentMessages), [agentMessages])

  const sendAddressedText = useCallback(
    async (rawText: string) => {
      if (!agent) {
        return
      }
      await sendText(buildAddressedMessage(rawText, agent))
    },
    [agent, sendText],
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

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) {
      return
    }
    container.scrollTop = container.scrollHeight
    // The thinking ticker grows the bubble's content, so it pins like a new row.
  }, [
    agent?.id,
    feedItems.length,
    optimisticMessages.length,
    agentPendingMessages.length,
    countThinkingEntries(agentPendingMessages),
  ])

  if (!agent || !activeChannel) {
    return null
  }

  const providerModel = [agent.provider, agent.model].filter(Boolean).join(' / ')

  return (
    <>
      <button
        aria-label="Close agent info"
        className="fixed inset-0 z-40 bg-[var(--scrim-strong)]"
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label={`${agent.name} info`}
        className={[
          'fixed inset-y-0 right-0 z-50 flex w-[min(430px,100vw)] flex-col',
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
          ref={scrollRef}
        >
          <ChannelMessageFeed
            agentById={agentMap}
            agentMap={agentMap}
            editingContent={editingContent}
            editingMessageId={editingMessageId}
            feedItems={feedItems}
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

        <ChannelComposer
          isSendPending={isSendPending}
          mentionEntities={mentionEntities}
          mentionRef={mentionRef}
          message={message}
          placeholder={`Message @${agent.name} in ${channelLabel(activeChannel)}`}
          onChangeMessage={setMessage}
          onInsertAtSign={() => mentionRef.current?.insertAtSign()}
          onInsertHashSign={() => mentionRef.current?.insertHashSign()}
          onOversizePaste={(paste) => setOversizePaste(paste)}
          onSubmitForm={(event) => void sendAddressedForm(event)}
          onSubmitText={(text) => void sendAddressedText(text)}
          pendingAgentInvites={pendingAgentInvites}
          invitingAgentId={invitingAgentId}
          inviteErrors={inviteErrors}
          onInvitePendingAgent={(agentId) => void invitePendingAgent(agentId)}
          onDismissPendingAgent={dismissPendingAgent}
        />
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
