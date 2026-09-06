import type { ReactNode } from 'react'
import type { ThreadMessageRecord } from '../../../lib/api-client'
import type { AttachmentRecord } from '../../../lib/uploads'
import { MessageAttachments, useMessageAttachments } from '../../shared/MessageAttachments'
import { ChannelMessageActions } from './ChannelMessageActions'
import { AgentCardMessage } from './AgentCardMessage'
import { AgentHandoffDoorway } from './AgentHandoffDoorway'
import { AllowedByRuleCard } from './AllowedByRuleCard'
import { AppSetupCard } from './AppSetupCard'
import { CommsConnectCard } from './CommsConnectCard'
import { DocumentRefChip } from './DocumentRefChip'
import { EmailAccountConnectCard } from './EmailAccountConnectCard'
import { GmailDraftCard } from './GmailDraftCard'
import { GoogleScopeRequestCard } from './GoogleScopeRequestCard'
import { MailSurfaceDoorwayChip } from './MailSurfaceDoorway'
import { MarkdownEditInput } from './MarkdownEditInput'
import { MessageMarkdown } from './MessageMarkdown'
import { MessageUiCards } from './MessageUiCards'
import type { ResolveReactorName } from './ReactionPills'
import { RestrictedMessageCard, type DisclosureDuration } from './RestrictedMessageCard'
import { RunApprovalGate } from './RunApprovalGate'
import { RunStopContinue } from './RunStopContinue'
import { TodoProgressCard } from './TodoProgressCard'
import { VoiceCallMessage, readVoiceCallRecord } from './VoiceCallMessage'
import { WebSearchResultsCard } from './WebSearchResultsCard'
import { WorkflowPreviewCard } from './WorkflowPreviewCard'
import { WorkflowRunCard } from './WorkflowRunCard'
import { DashboardPresentation } from '../dashboards/DashboardPresentation'
import { TaskPresentation } from './TaskPresentation'
import { EmbeddedWidget, readMessageEmbedIds } from '../dashboards/EmbeddedWidget'
import { ReplySummaryBar } from './thread-panel/ReplySummaryBar'
import { getReplyBroadcastRootId, type ThreadParticipant } from './thread-panel/thread-replies'

interface ChannelMessageBodyProps {
  message: ThreadMessageRecord
  canDelete: boolean
  canEdit: boolean
  meUserId: string
  token: string | null
  isExternalAgentConversation: boolean
  renderContent: (text: string) => ReactNode
  isEditingMessage: boolean
  editingContent: string
  updatePending: boolean
  onStartEdit: (messageId: string, content: string) => void
  shareRestrictedMessage?: (
    messageId: string,
    input: { kind: 'message' | 'scope'; duration: DisclosureDuration },
  ) => Promise<void>
  onChangeEditingContent: (value: string) => void
  onSubmitEdit: (messageId: string) => void
  onCancelEdit: () => void
  onAddReaction: (messageId: string, emoji: string) => void
  onConfirmDelete: (messageId: string) => void
  onOpenThread?: (rootMessageId: string) => void
  onOpenAttachment?: (attachment: AttachmentRecord) => void
  resolveReactorName: ResolveReactorName
  resolveThreadParticipant?: (participantId: string) => ThreadParticipant | null
}

// The row owns focus, identity and row-level keyboard actions. This component
// owns the message payload: content, cards, attachments, reply affordances and
// edit state. Keeping the payload together means a new card does not change
// author identity or navigation behavior.
export const ChannelMessageBody = ({
  message,
  canDelete,
  canEdit,
  meUserId,
  token,
  isExternalAgentConversation,
  renderContent,
  isEditingMessage,
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
  resolveReactorName,
  resolveThreadParticipant,
}: ChannelMessageBodyProps) => {
  const voiceCall = readVoiceCallRecord(message.metadata)
  const attachments = useMessageAttachments((message.attachmentCount ?? 1) > 0 ? message.id : null)
  const transcriptAttachment = voiceCall?.transcriptAttachmentId
    ? attachments.find((attachment) => attachment.id === voiceCall.transcriptAttachmentId)
    : undefined
  const carriesAgentCard = Boolean(
    (message.metadata as { agentCard?: unknown } | undefined)?.agentCard,
  )
  const carriesWebSearchCard = Boolean(
    (message.metadata as { webSearch?: unknown } | undefined)?.webSearch,
  )
  const threadRootMessageId = message.rootMessageId ?? message.id
  const broadcastRootId = getReplyBroadcastRootId(message.metadata)
  const openThread =
    onOpenThread && !isEditingMessage ? () => onOpenThread(threadRootMessageId) : undefined

  return (
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
          {/* A card message's `content` is the same card rendered as plain text.
              Other clients and the model use it; the feed renders the card once. */}
          {carriesAgentCard || carriesWebSearchCard || voiceCall ? null : (
            <MessageMarkdown renderInlineText={renderContent}>{message.content}</MessageMarkdown>
          )}
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
          isExternalAgent={isExternalAgentConversation && message.role === 'assistant'}
          metadata={message.metadata}
        />
      ) : null}
      {!isEditingMessage
        ? readMessageEmbedIds(message.metadata).map((embedId) => (
          <div className="mt-2" key={embedId}>
            <EmbeddedWidget embedId={embedId} surface="message" />
          </div>
        ))
        : null}
      {!isEditingMessage ? <DashboardPresentation metadata={message.metadata} threadId={message.threadId} /> : null}
      {!isEditingMessage ? <TaskPresentation metadata={message.metadata} /> : null}
      {!isEditingMessage ? <CommsConnectCard metadata={message.metadata} /> : null}
      {!isEditingMessage ? <EmailAccountConnectCard metadata={message.metadata} /> : null}
      {!isEditingMessage ? <GmailDraftCard metadata={message.metadata} /> : null}
      {!isEditingMessage ? (
        <MailSurfaceDoorwayChip messageId={message.id} metadata={message.metadata} />
      ) : null}
      {!isEditingMessage ? <GoogleScopeRequestCard metadata={message.metadata} /> : null}
      {!isEditingMessage ? <AllowedByRuleCard metadata={message.metadata} /> : null}
      {!isEditingMessage ? <AppSetupCard metadata={message.metadata} /> : null}
      {!isEditingMessage ? <RunStopContinue metadata={message.metadata} /> : null}
      {!isEditingMessage ? <RunApprovalGate metadata={message.metadata} /> : null}
      {!isEditingMessage ? <AgentCardMessage metadata={message.metadata} /> : null}
      {!isEditingMessage ? <WebSearchResultsCard metadata={message.metadata} /> : null}
      {!isEditingMessage ? <TodoProgressCard metadata={message.metadata} /> : null}
      {!isEditingMessage ? <DocumentRefChip metadata={message.metadata} /> : null}
      {!isEditingMessage ? <AgentHandoffDoorway metadata={message.metadata} /> : null}
      {!isEditingMessage ? <WorkflowRunCard metadata={message.metadata} /> : null}
      {!isEditingMessage ? <WorkflowPreviewCard metadata={message.metadata} /> : null}
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
          canDelete={canDelete}
          canEdit={canEdit}
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
  )
}
