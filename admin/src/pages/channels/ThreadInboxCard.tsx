import { useCallback, useMemo, useState } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type {
  AgentRecord,
  ChannelRecord,
  UserRecord,
} from '../../lib/api-client'
import { useThreadMessage, useThreadReplies } from '../../facades/threads/hooks'
import type { ThreadActivity } from '../../facades/threads/activity-hooks'
import { useChannelComposer } from '../../components/features/channels/useChannelComposer'
import { ChannelComposer } from '../../components/features/channels/ChannelComposer'
import { ChannelMessageFeed } from '../../components/features/channels/ChannelMessageFeed'
import { buildFeedItems } from '../../components/features/channels/channel-helpers'
import { useChannelMessageActions } from '../../components/features/channels/useChannelMessageActions'
import { OversizePasteDialog } from '../../components/shared/OversizePasteDialog'
import { useChannelMentions } from './useChannelMentions'

type ThreadInboxCardProps = {
  activity: ThreadActivity
  agents: AgentRecord[]
  channels: ChannelRecord[]
  currentUser: {
    avatarAttachmentId?: string | null
    avatarUrl?: string | null
    displayName: string
    id: string
  }
  token: string | null
  users: UserRecord[]
  onOpen: () => void
}

const channelContextLabel = (channel: ChannelRecord | undefined, fallback: string) =>
  channel?.type === 'dm' ? channel.label : `#${fallback}`

// The inbox mirrors Slack's conversation-card shape, but uses the shared
// message feed and composer. That keeps reply-thread permissions, reactions,
// attachments and rich text identical to their channel counterparts.
export const ThreadInboxCard = ({
  activity,
  agents,
  channels,
  currentUser,
  token,
  users,
  onOpen,
}: ThreadInboxCardProps) => {
  const channel = channels.find((entry) => entry.id === activity.channelId) ?? null
  const rootQuery = useThreadMessage(activity.threadId, activity.rootMessageId)
  const repliesQuery = useThreadReplies(activity.threadId, activity.rootMessageId)
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false)
  const channelUsers = useMemo(
    () => users.filter((user) => user.channelIds.includes(activity.channelId)),
    [activity.channelId, users],
  )
  const { mentionEntities, renderContent } = useChannelMentions({
    activeChannel: channel,
    agents,
    channels,
    channelUsers,
  })
  const messages = useMemo(
    () => (rootQuery.data?.message ? [rootQuery.data.message, ...(repliesQuery.data ?? [])] : []),
    [repliesQuery.data, rootQuery.data],
  )
  const getSendExtras = useCallback(
    () => ({ alsoSendToChannel, rootMessageId: activity.rootMessageId }),
    [activity.rootMessageId, alsoSendToChannel],
  )
  const composer = useChannelComposer({
    activeChannel: channel,
    currentUserId: currentUser.id,
    getSendExtras,
    threadMessages: messages,
  })
  const messageActions = useChannelMessageActions(channel?.defaultThreadId)
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const isLoading = rootQuery.isLoading || repliesQuery.isLoading
  const hasFailed = rootQuery.isError || repliesQuery.isError

  return (
    <article
      className={[
        'overflow-hidden rounded-xl border bg-[color:var(--surface)] shadow-sm',
        activity.unread
          ? 'border-l-4 border-l-[color:var(--accent)] border-[color:var(--border-strong)]'
          : 'border-[color:var(--border-strong)]',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3 border-b border-[color:var(--sep)] px-5 py-3">
        <button
          className="min-w-0 text-left outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          onClick={onOpen}
          type="button"
        >
          <div className="font-semibold text-[color:var(--tx)]">
            {channelContextLabel(channel ?? undefined, activity.channelLabel)}
          </div>
          <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
            {activity.replyCount} {activity.replyCount === 1 ? 'reply' : 'replies'}
            {activity.unread ? ' · New activity' : ''}
          </div>
        </button>
        <button
          className="admin-button-secondary flex-shrink-0 text-xs"
          onClick={onOpen}
          type="button"
        >
          Open thread
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-3 p-5" aria-label="Loading thread">
          <div className="h-10 animate-pulse rounded bg-[color:var(--surface-hover)]" />
          <div className="h-16 animate-pulse rounded bg-[color:var(--surface-hover)]" />
        </div>
      ) : null}
      {hasFailed ? (
        <div className="p-5 text-sm text-[color:var(--danger-text)]">
          This conversation could not be loaded. Open it to try again.
        </div>
      ) : null}
      {!isLoading && !hasFailed ? (
        <>
          <ChannelMessageFeed
            agentById={agentMap}
            agentMap={agentMap}
            channelUsers={channelUsers}
            editingContent={messageActions.editingContent}
            editingMessageId={messageActions.editingMessageId}
            feedItems={buildFeedItems(messages)}
            isPersonalAssistantConversation={false}
            meAvatar={{
              avatarAttachmentId: currentUser.avatarAttachmentId ?? undefined,
              avatarUrl: currentUser.avatarUrl ?? undefined,
            }}
            meDisplayName={currentUser.displayName}
            meUserId={currentUser.id}
            optimisticMessages={composer.optimisticMessages}
            pendingMessages={[]}
            renderContent={renderContent}
            token={token}
            updatePending={messageActions.updatePending}
            onAddReaction={messageActions.addReaction}
            onCancelEdit={messageActions.cancelEdit}
            onChangeEditingContent={messageActions.changeEditingContent}
            onConfirmDelete={messageActions.confirmDelete}
            onStartEdit={messageActions.startEdit}
            onSubmitEdit={(messageId) => void messageActions.submitEdit(messageId)}
          />
          <label className="flex items-center gap-2 px-5 pb-1 text-xs text-[color:var(--tx2)]">
            <input
              checked={alsoSendToChannel}
              className="accent-[var(--accent)]"
              onChange={(event) => setAlsoSendToChannel(event.target.checked)}
              type="checkbox"
            />
            Also send to {channelContextLabel(channel ?? undefined, activity.channelLabel)}
          </label>
          <ChannelComposer
            attachments={composer.attachments}
            inviteErrors={composer.inviteErrors}
            invitingAgentId={composer.invitingAgentId}
            isSendPending={composer.isSendPending}
            mentionEntities={mentionEntities}
            mentionRef={composer.mentionRef}
            message={composer.message}
            pendingAgentInvites={composer.pendingAgentInvites}
            placeholder="Reply to thread"
            onChangeMessage={composer.setMessage}
            onDismissPendingAgent={composer.dismissPendingAgent}
            onInsertAtSign={() => composer.mentionRef.current?.insertAtSign()}
            onInsertEmoji={composer.insertEmoji}
            onInsertHashSign={() => composer.mentionRef.current?.insertHashSign()}
            onInvitePendingAgent={(agentId) => void composer.invitePendingAgent(agentId)}
            onOversizePaste={composer.setOversizePaste}
            onSubmitForm={(event) => void composer.sendMessageSubmit(event)}
            onSubmitText={(text) => void composer.sendText(text)}
          />
        </>
      ) : null}

      <OversizePasteDialog
        limit={CHAT_MESSAGE_MAX_CHARS}
        open={composer.oversizePaste !== null}
        pastedText={composer.oversizePaste ?? ''}
        onCancel={() => composer.setOversizePaste(null)}
        onInsertTrimmed={(trimmed) => {
          composer.setOversizePaste(null)
          composer.mentionRef.current?.insertText(trimmed)
        }}
        onSendAsFile={composer.sendAsFile}
      />
    </article>
  )
}
