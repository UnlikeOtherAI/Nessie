import type { Dispatch, KeyboardEvent, MouseEvent, MutableRefObject, ReactNode, SetStateAction } from 'react'
import type {
  AgentRecord,
  PersonalAssistantPresenceParticipant,
  ThreadMessageRecord,
} from '../../../lib/api-client'
import type { PresenceView } from '../../../providers/PresenceProvider'
import { useAgentIdentityLookup } from '../../../providers/AgentIdentityProvider'
import type { AvatarSources } from '../../primitives/UserAvatar'
import { UserStatusEmoji } from '../../primitives/UserStatusEmoji'
import { MessageAttachments, useMessageAttachments } from '../../shared/MessageAttachments'
import type { AttachmentRecord } from '../../../lib/uploads'
import { MessageAuthorAvatar } from './MessageAuthorAvatar'
import { ChannelMessageActions } from './ChannelMessageActions'
import type { ResolveReactorName } from './ReactionPills'
import {
  formatClock,
  getDisplayName,
  type ChannelAgentParticipant,
  type MessageUserIdentity,
} from './channel-helpers'
import { MessageUiCards } from './MessageUiCards'
import { readVoiceCallRecord, VoiceCallMessage } from './VoiceCallMessage'
import {
  EmbeddedWidget,
  readMessageEmbedIds,
} from '../dashboards/EmbeddedWidget'
import { DashboardPresentation } from '../dashboards/DashboardPresentation'
import { CommsConnectCard } from './CommsConnectCard'
import { EmailAccountConnectCard } from './EmailAccountConnectCard'
import { GmailDraftCard } from './GmailDraftCard'
import { GoogleScopeRequestCard } from './GoogleScopeRequestCard'
import { AllowedByRuleCard } from './AllowedByRuleCard'
import { AppSetupCard } from './AppSetupCard'
import { AgentCardMessage } from './AgentCardMessage'
import { MessageMarkdown } from './MessageMarkdown'
import { MarkdownEditInput } from './MarkdownEditInput'
import { RestrictedMessageCard, type DisclosureDuration } from './RestrictedMessageCard'
import { DocumentRefChip } from './DocumentRefChip'
import { AgentHandoffDoorway } from './AgentHandoffDoorway'
import { RunStopContinue } from './RunStopContinue'
import { RunApprovalGate } from './RunApprovalGate'
import { TodoProgressCard } from './TodoProgressCard'
import { WorkflowRunCard } from './WorkflowRunCard'
import { MailSurfaceDoorwayChip } from './MailSurfaceDoorway'
import { ReplySummaryBar } from './thread-panel/ReplySummaryBar'
import {
  getReplyBroadcastRootId,
  type ThreadParticipant,
} from './thread-panel/thread-panel-helpers'
import { readWatchStatusSummary } from '../../../facades/channels/watch-status'
import { isAgentCardResponseMessage } from '@nessie/schemas'

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
export const StatusBadge = ({ presence }: { presence: PresenceView | null }) => {
  const emoji = presence?.statusEmoji ?? null
  const label = presence?.statusLabel ?? null
  if (emoji) {
    return <UserStatusEmoji statusEmoji={emoji} statusLabel={label} />
  }

  return (
    <span className="admin-status-badge">
      <span className="admin-status-badge-icon"><SpeechBubbleIcon /></span>
    </span>
  )
}

interface ChannelMessageRowProps {
  message: ThreadMessageRecord
  agentMap: Map<string, AgentRecord>
  meDisplayName: string
  meUserId: string
  meAvatar: AvatarSources
  token: string | null
  assistantFallbackName: string
  personalAssistantPresence: PersonalAssistantPresenceParticipant | null
  isDedicatedAgentConversation: boolean
  // A first-class external-agent turn (DeepSignal, ...) renders its narrated
  // activities as a collapsed plan/timeline; other surfaces render flat cards.
  isExternalAgentConversation: boolean
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
  // Opens the reply-thread panel for this message's root (#233). When absent
  // the row renders no thread affordances at all.
  onOpenThread?: (rootMessageId: string) => void
  // Opens the full-size viewer. Owned by the feed, not by this row: a modal
  // rendered here would inherit the row's stacking/overflow ancestors.
  onOpenAttachment?: (attachment: AttachmentRecord) => void
  onSelectAgent?: (agent: ChannelAgentParticipant) => void
  onSelectUser?: (user: MessageUserIdentity) => void
  resolveReactorName: ResolveReactorName
  resolveThreadParticipant?: (participantId: string) => ThreadParticipant | null
  getPresence: (userId: string | null | undefined) => PresenceView | null
  activeActionMessageId: string | null
  setActiveActionMessageId: Dispatch<SetStateAction<string | null>>
  lastPointerDownAt: MutableRefObject<number>
}

// One message's row in the feed: avatar, author name + status/agent chips,
// content (or its inline editor), UI cards, attachments, and hover actions.
// Split out of ChannelMessageFeed so the feed component stays focused on
// list/grouping machinery rather than a single row's render logic.
export const ChannelMessageRow = ({
  message,
  agentMap,
  meDisplayName,
  meUserId,
  meAvatar,
  token,
  assistantFallbackName,
  personalAssistantPresence,
  isDedicatedAgentConversation,
  isExternalAgentConversation,
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
  onOpenAttachment,
  onSelectAgent,
  onSelectUser,
  resolveReactorName,
  resolveThreadParticipant,
  getPresence,
  activeActionMessageId,
  setActiveActionMessageId,
  lastPointerDownAt,
}: ChannelMessageRowProps) => {
  const watchStatus = readWatchStatusSummary(message.metadata)
  // The channel's `agentMap` is the entitled projection — what this viewer may
  // *act on*. The identity directory is what an agent *looks like*, and it
  // alone answers for system-managed agents such as the Agent Designer, which
  // post into their own DMs but never appear in a picker.
  const lookupAgentIdentity = useAgentIdentityLookup()
  const authoringAgent =
    message.role === 'assistant'
      ? agentMap.get(message.agentId ?? '') ?? lookupAgentIdentity(message.agentId)
      : null
  const displayName = getDisplayName(
    message,
    meDisplayName,
    authoringAgent,
    assistantFallbackName,
    personalAssistantPresence?.displayName,
  )
  const canManageOwnMessage = message.role === 'user' && message.userId === meUserId
  // A card press is a record, not a remark. The server refuses the edit
  // (`MESSAGE_IMMUTABLE_CARD_RESPONSE`); offering the pencil here would only
  // walk the presser into that error. Delete stays — a tombstone changes
  // nothing on the card, which remains the authority.
  const canEditOwnMessage = canManageOwnMessage && !isAgentCardResponseMessage(message.metadata)
  // A finished call: server-written metadata, so this is structural rather
  // than a reading of the text.
  const voiceCall = readVoiceCallRecord(message.metadata)
  const carriesVoiceCall = voiceCall !== null
  // The transcript lives on this message with any ordinary files. Fetch once,
  // then let the voice-call card own its particular attachment.
  const attachments = useMessageAttachments((message.attachmentCount ?? 1) > 0 ? message.id : null)
  const transcriptAttachment = voiceCall?.transcriptAttachmentId
    ? attachments.find((attachment) => attachment.id === voiceCall.transcriptAttachmentId)
    : undefined
  const isEditingMessage = editingMessageId === message.id
  // Replies open their root's thread; roots open their own.
  const threadRootMessageId = message.rootMessageId ?? message.id
  const broadcastRootId = getReplyBroadcastRootId(message.metadata)
  const openThread =
    onOpenThread && !isEditingMessage ? () => onOpenThread(threadRootMessageId) : undefined
  // Opening an agent's drawer is an action, so it stays gated on the entitled
  // map: the directory can name a system agent this viewer has no page for.
  const messageAgent =
    message.role === 'assistant' && onSelectAgent && !personalAssistantPresence
      ? agentMap.get(message.agentId ?? '') ?? null
      : null
  const assistantAvatar = personalAssistantPresence
    ? {
        avatarAttachmentId: personalAssistantPresence.avatarAttachmentId,
        id: personalAssistantPresence.agentId,
        name: personalAssistantPresence.displayName,
        role: 'Personal Assistant',
      }
    : authoringAgent ?? undefined
  const authorIdentity =
    message.role === 'user' && message.userId && onSelectUser
      ? {
          avatarAttachmentId: message.author?.avatarAttachmentId
            ?? (message.userId === meUserId ? meAvatar.avatarAttachmentId : undefined),
          avatarUrl: message.author?.avatarUrl
            ?? (message.userId === meUserId ? meAvatar.avatarUrl : undefined),
          displayName,
          id: message.userId,
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
  const selectPersonalAssistant = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (personalAssistantPresence) {
      onSelectAgent?.(personalAssistantPresence)
    }
  }
  // Slack-style shortcut: `t` opens the thread for the focused message (or its
  // root, when the focused row is itself a reply).
  const openThreadOnKey = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key !== 't' && event.key !== 'T') || !onOpenThread) {
      return
    }
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable="true"]')) {
      return
    }
    event.preventDefault()
    onOpenThread(threadRootMessageId)
  }

  // Structural: the server stamped a card pointer on this message.
  const carriesAgentCard = Boolean(
    (message.metadata as { agentCard?: unknown } | undefined)?.agentCard,
  )
  return (
    <article
      key={message.id}
      id={`msg-${message.id}`}
      aria-label={`Message from ${displayName}`}
      className="admin-msg-row relative py-1"
      data-actions-open={activeActionMessageId === message.id}
      onClick={() => {
        setActiveActionMessageId((current) => (current === message.id ? null : message.id))
      }}
      onFocus={() => {
        if (Date.now() - lastPointerDownAt.current > 500) {
          setActiveActionMessageId(message.id)
        }
      }}
      onKeyDown={openThreadOnKey}
      onPointerDown={() => {
        lastPointerDownAt.current = Date.now()
      }}
      tabIndex={0}
    >
      <MessageAuthorAvatar
        agent={personalAssistantPresence ? assistantAvatar : messageAgent ?? assistantAvatar}
        agentId={personalAssistantPresence?.agentId ?? message.agentId ?? null}
        displayName={displayName}
        isAgent={message.role === 'assistant' || Boolean(personalAssistantPresence)}
        onOpen={
          personalAssistantPresence
            ? selectPersonalAssistant
            : messageAgent
              ? selectAgent
              : authorIdentity
                ? selectAuthor
                : undefined
        }
        user={{
          avatarAttachmentId: message.author?.avatarAttachmentId ?? undefined,
          avatarUrl: message.author?.avatarUrl ?? undefined,
          userId: message.author?.id,
        }}
        token={token}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {personalAssistantPresence || messageAgent || authorIdentity ? (
            <button
              className="min-w-0 text-left text-sm font-bold text-[var(--tx)] hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={personalAssistantPresence ? selectPersonalAssistant : messageAgent ? selectAgent : selectAuthor}
              type="button"
            >
              {displayName}
            </button>
          ) : (
            <span className="text-sm font-bold text-[var(--tx)]">{displayName}</span>
          )}
          {message.role === 'user' ? (
            <StatusBadge presence={getPresence(message.userId)} />
          ) : null}
          {message.role === 'assistant' && !isDedicatedAgentConversation ? (
            <span
              className={[
                'inline-flex items-center gap-1 rounded',
                'border border-[var(--accent)]',
                'bg-[var(--accent-soft)] px-1.5 py-0.5',
                'text-[11px] font-semibold text-[var(--thinking)]',
              ].join(' ')}
            >
              {personalAssistantPresence ? 'PA' : 'agent'}
            </span>
          ) : null}
          <span className="text-xs text-[color:var(--tx3)]">
            {formatClock(message.createdAt)}
          </span>
          {watchStatus ? (
            // A recurring watch keeps one status line and edits it in place, so
            // "(edited)" would be misleading — the useful facts are how many
            // times it has run and when it last did.
            <span className="text-xs text-[color:var(--tx3)]">
              {`checked ${watchStatus.runCount}× · last ${formatClock(watchStatus.lastRunAt)}`}
            </span>
          ) : message.editedAt ? (
            <span className="text-xs italic text-[color:var(--tx3)]">(edited)</span>
          ) : null}
        </div>
        <div
          className={
            message.role === 'assistant'
              ? 'mt-0.5 border-l-2 border-[var(--accent)] pl-3'
              : 'mt-0.5'
          }
        >
          {isEditingMessage ? (
            <div className="flex flex-col gap-2">
              <MarkdownEditInput
                value={editingContent}
                onCancel={onCancelEdit}
                onChange={onChangeEditingContent}
                onSubmit={() => onSubmitEdit(message.id)}
              />
              <div className="flex items-center gap-2">
                <button
                  className="admin-button admin-button-primary"
                  disabled={updatePending}
                  onClick={() => onSubmitEdit(message.id)}
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
          ) : message.restricted ? (
            <RestrictedMessageCard
              allowStanding={false}
              messageId={message.id}
              mode="withheld"
              onShare={async () => undefined}
            />
          ) : (
            <>
              {/* A card message's `content` is the same card rendered as plain
                  text — it exists so search, push previews, other clients and
                  the model's transcript all see what the card says. Here the
                  card itself renders below, so printing both says everything
                  twice. */}
              {carriesAgentCard || carriesVoiceCall ? null : (
                <MessageMarkdown renderInlineText={renderContent}>
                  {message.content}
                </MessageMarkdown>
              )}
              {/* A call leaves a compaction in the message and the verbatim
                  transcript as an attachment; the card shows the first and
                  opens the second in place. */}
              {voiceCall ? (
                <VoiceCallMessage
                  compacted={voiceCall.compacted}
                  content={message.content}
                  transcriptAttachmentId={voiceCall.transcriptAttachmentId}
                  transcriptAttachment={transcriptAttachment}
                />
              ) : null}
              {message.restrictedSources && shareRestrictedMessage ? (
                <div className="mt-2">
                  <RestrictedMessageCard
                    allowStanding={message.canShareStanding ?? false}
                    messageId={message.id}
                    mode="shareable"
                    onShare={(input) => shareRestrictedMessage(message.id, input)}
                  />
                </div>
              ) : null}
            </>
          )}
          {!isEditingMessage ? (
            <MessageUiCards
              isExternalAgent={
                isExternalAgentConversation && message.role === 'assistant'
              }
              metadata={message.metadata}
            />
          ) : null}
          {/* Dashboard widgets quoted into the conversation. Each resolves by
              embed id, so the server decides visibility per viewer. */}
          {!isEditingMessage
            ? readMessageEmbedIds(message.metadata).map((embedId) => (
              <div className="mt-2" key={embedId}>
                <EmbeddedWidget embedId={embedId} surface="message" />
              </div>
            ))
            : null}
          {!isEditingMessage ? <DashboardPresentation metadata={message.metadata} /> : null}
          {!isEditingMessage ? (
            <CommsConnectCard metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <EmailAccountConnectCard metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <GmailDraftCard metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <MailSurfaceDoorwayChip messageId={message.id} metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <GoogleScopeRequestCard metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <AllowedByRuleCard metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <AppSetupCard metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <RunStopContinue metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <RunApprovalGate metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <AgentCardMessage metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <TodoProgressCard metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <DocumentRefChip metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <AgentHandoffDoorway metadata={message.metadata} />
          ) : null}
          {!isEditingMessage ? (
            <WorkflowRunCard metadata={message.metadata} />
          ) : null}
          {/* Mount only when the message actually has files. The count comes
              from the message contract; when it is absent (an optimistic or
              realtime-seeded row) we still mount, so a real attachment is
              never hidden by a missing count. */}
          {(message.attachmentCount ?? 1) > 0 ? (
            <MessageAttachments
              attachments={attachments}
              omitAttachmentId={voiceCall?.transcriptAttachmentId}
              onOpenAttachment={onOpenAttachment}
            />
          ) : null}
          {broadcastRootId && onOpenThread ? (
            <button
              className={[
                'mt-1 inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5',
                'bg-[var(--accent-soft)] text-[11px] font-semibold text-[var(--thinking)]',
                'transition-colors hover:bg-[color:var(--main-hover)]',
              ].join(' ')}
              onClick={(event) => {
                event.stopPropagation()
                onOpenThread(broadcastRootId)
              }}
              type="button"
            >
              from a thread
            </button>
          ) : null}
          {!message.rootMessageId && (message.replyCount ?? 0) > 0 && onOpenThread ? (
            <ReplySummaryBar
              lastReplyAt={message.lastReplyAt ?? null}
              participantIds={message.replyParticipantIds ?? []}
              replyCount={message.replyCount ?? 0}
              resolveParticipant={resolveThreadParticipant ?? (() => null)}
              token={token}
              onOpen={() => onOpenThread(message.id)}
            />
          ) : null}
          {!isEditingMessage ? (
            <ChannelMessageActions
              canDelete={canManageOwnMessage}
              canEdit={canEditOwnMessage}
              content={message.content}
              currentUserId={meUserId}
              messageId={message.id}
              reactions={message.reactions ?? []}
              resolveReactorName={resolveReactorName}
              onAddReaction={onAddReaction}
              onConfirmDelete={onConfirmDelete}
              onReply={openThread}
              onStartEdit={onStartEdit}
            />
          ) : null}
        </div>
      </div>
    </article>
  )
}
