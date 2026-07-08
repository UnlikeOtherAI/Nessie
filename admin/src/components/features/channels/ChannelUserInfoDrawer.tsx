import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import { useOpenDm } from '../../../facades/channels/hooks'
import { useThreadMessages, useThreadStream } from '../../../facades/threads/hooks'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../../lib/api-client'
import type { AvatarSources } from '../../primitives/UserAvatar'
import { UserAvatar } from '../../primitives/UserAvatar'
import { OversizePasteDialog } from '../../shared/OversizePasteDialog'
import type { MentionEntity } from '../../shared/MentionInput'
import { ChannelComposer } from './ChannelComposer'
import { ChannelMessageFeed } from './ChannelMessageFeed'
import {
  buildFeedItems,
  type MessageUserIdentity,
} from './channel-helpers'
import { useChannelComposer } from './useChannelComposer'
import { useChannelMessageActions } from './useChannelMessageActions'

type ChannelUserInfoDrawerProps = {
  agents: AgentRecord[]
  meAvatar: AvatarSources
  meDisplayName: string
  meUserId: string
  onClose: () => void
  target: MessageUserIdentity | null
  token: string | null
  users: UserRecord[]
}

const emptyMentions: MentionEntity[] = []

const toAvatarSources = (
  user: MessageUserIdentity | UserRecord,
): AvatarSources => ({
  avatarAttachmentId: user.avatarAttachmentId ?? undefined,
  avatarUrl: user.avatarUrl ?? undefined,
  gravatarUrl: user.gravatarUrl ?? undefined,
})

export const ChannelUserInfoDrawer = ({
  agents,
  meAvatar,
  meDisplayName,
  meUserId,
  onClose,
  target,
  token,
  users,
}: ChannelUserInfoDrawerProps) => {
  const { mutate: openDirectMessage } = useOpenDm()
  const [dmChannel, setDmChannel] = useState<ChannelRecord | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const user = useMemo(() => {
    if (!target) {
      return null
    }

    const fullUser = users.find((entry) => entry.id === target.id)
    return {
      ...target,
      activeStatus: fullUser?.activeStatus,
      avatarAttachmentId: fullUser?.avatarAttachmentId ?? target.avatarAttachmentId,
      avatarUrl: fullUser?.avatarUrl ?? target.avatarUrl,
      email: fullUser?.email,
      gravatarUrl: fullUser?.gravatarUrl ?? target.gravatarUrl,
      role: fullUser?.role,
      displayName: fullUser?.displayName ?? target.displayName,
    }
  }, [target, users])

  useEffect(() => {
    if (!target) {
      setDmChannel(null)
      setOpenError(null)
      return
    }

    let cancelled = false
    setDmChannel(null)
    setOpenError(null)
    openDirectMessage(target.id, {
      onError: () => {
        if (!cancelled) {
          setOpenError('Conversation unavailable')
        }
      },
      onSuccess: (channel) => {
        if (!cancelled) {
          setDmChannel(channel)
        }
      },
    })

    return () => {
      cancelled = true
    }
  }, [openDirectMessage, target])

  const { data: threadMessages = [] } = useThreadMessages(dmChannel?.defaultThreadId)
  const { pendingMessages } = useThreadStream(dmChannel?.defaultThreadId)
  const feedItems = useMemo(() => buildFeedItems(threadMessages), [threadMessages])
  const agentMap = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )
  const renderContent = useCallback((text: string) => text, [])
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
    activeChannel: dmChannel,
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
  } = useChannelMessageActions(dmChannel?.defaultThreadId)

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) {
      return
    }

    container.scrollTop = container.scrollHeight
  }, [dmChannel?.id, feedItems.length, optimisticMessages.length, pendingMessages.length])

  if (!user) {
    return null
  }

  const activeStatus = user.activeStatus?.activeNow ? user.activeStatus : null

  return (
    <>
      <button
        aria-label="Close user info"
        className="fixed inset-0 z-40 bg-[var(--scrim-strong)]"
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label={`${user.displayName} info`}
        className={[
          'fixed inset-y-0 right-0 z-50 flex w-[min(430px,100vw)] flex-col',
          'border-l border-[color:var(--sep)] bg-[color:var(--main)]',
          'shadow-[0_32px_80px_var(--scrim-strong)]',
        ].join(' ')}
      >
        <header className="flex-shrink-0 border-b border-[color:var(--sep)] px-5 pb-4 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <UserAvatar
                {...toAvatarSources(user)}
                displayName={user.displayName}
                ringColor="var(--main)"
                showPresence
                showStatus
                size={46}
                token={token}
                userId={user.id}
              />
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-[var(--tx)]">
                  {user.displayName}
                </h2>
                {user.email ? (
                  <div className="truncate text-xs text-[color:var(--tx3)]">
                    {user.email}
                  </div>
                ) : null}
                {activeStatus ? (
                  <div className="mt-1 flex items-center gap-1 text-xs text-[color:var(--tx2)]">
                    {activeStatus.emoji ? <span>{activeStatus.emoji}</span> : null}
                    <span className="truncate">{activeStatus.label}</span>
                  </div>
                ) : null}
              </div>
            </div>
            <button
              className="admin-button admin-button-secondary h-9 px-3"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
        </header>

        <div
          className="min-h-0 flex-1 overflow-y-auto py-2"
          data-testid="user-info-drawer-messages"
          ref={scrollRef}
        >
          {openError ? (
            <div className="px-5 py-4 text-sm text-[color:var(--danger-text)]">
              {openError}
            </div>
          ) : null}
          {!dmChannel && !openError ? (
            <div className="px-5 py-4 text-sm text-[color:var(--tx3)]">
              Opening conversation...
            </div>
          ) : null}
          {dmChannel ? (
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
              pendingMessages={pendingMessages}
              renderContent={renderContent}
              token={token}
              updatePending={updatePending}
              onAddReaction={addReaction}
              onCancelEdit={cancelEdit}
              onChangeEditingContent={changeEditingContent}
              onConfirmDelete={confirmDelete}
              onStartEdit={startEdit}
              onSubmitEdit={(messageId) => void submitEdit(messageId)}
            />
          ) : null}
        </div>

        {dmChannel ? (
          <ChannelComposer
            isSendPending={isSendPending}
            mentionEntities={emptyMentions}
            mentionRef={mentionRef}
            message={message}
            placeholder={`Message ${user.displayName}`}
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
        ) : null}
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
