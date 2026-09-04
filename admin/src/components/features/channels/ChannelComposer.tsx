import { useState, useRef, type FocusEvent, type FormEvent, type Ref } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import { faPaperclip } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  MentionInput,
  type AgentMention,
  type MentionEntity,
  type MentionInputHandle,
} from '../../shared/MentionInput'
import type { PendingAgentInvite } from '../../../facades/messages/hooks'
import type { SecretRecord } from '../../../facades/secrets/hooks'
import { toolbarButtonClass } from './channel-helpers'
import { ComposerAttachments } from './ComposerAttachments'
import { ComposerEmojiButton } from './ComposerEmojiButton'
import { SecretCaptureDialog } from './SecretCaptureDialog'
import type { SecretCapture } from './useChannelComposer'
import type { ComposerAttachments as ComposerAttachmentsState } from './useComposerAttachments'

interface ChannelComposerProps {
  mentionRef: Ref<MentionInputHandle>
  mentionEntities: MentionEntity[]
  placeholder: string
  message: string
  isSendPending: boolean
  sendError: string | null
  attachments: ComposerAttachmentsState
  onChangeMessage: (value: string) => void
  onOversizePaste: (paste: string) => void
  onSubmitText: (text: string, agentMentions: AgentMention[]) => void
  onSubmitForm: (event?: FormEvent<HTMLFormElement>) => void
  onInsertHashSign: () => void
  onInsertAtSign: () => void
  onInsertEmoji: (emoji: string) => void
  pendingAgentInvites: PendingAgentInvite[]
  invitingAgentId: string | null
  inviteErrors: Record<string, string>
  onInvitePendingAgent: (agentId: string) => void
  onDismissPendingAgent: (agentId: string) => void
  secretCapture: SecretCapture | null
  onConfirmSecretCapture: (secret: SecretRecord) => Promise<void>
  onDismissSecretCapture: () => void
  onOpenDeepWaterResearch?: () => void
  onOpenExecutorRun?: () => void
}

export const ChannelComposer = ({
  mentionRef,
  mentionEntities,
  placeholder,
  message,
  isSendPending,
  sendError,
  attachments,
  onChangeMessage,
  onOversizePaste,
  onSubmitText,
  onSubmitForm,
  onInsertHashSign,
  onInsertAtSign,
  onInsertEmoji,
  pendingAgentInvites,
  invitingAgentId,
  inviteErrors,
  onInvitePendingAgent,
  onDismissPendingAgent,
  secretCapture,
  onConfirmSecretCapture,
  onDismissSecretCapture,
  onOpenDeepWaterResearch,
  onOpenExecutorRun,
}: ChannelComposerProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isFocusWithin, setIsFocusWithin] = useState(false)
  // Text or at least one finished upload, and never mid-upload.
  const canSend =
    (message.trim().length > 0 || attachments.attachmentIds.length > 0)
    && !attachments.isUploading
    && !isSendPending

  // At rest the composer is a single line: just the placeholder and Send. It
  // opens while focus is anywhere inside it, and stays open while anything is
  // staged, so nothing a person has written or attached is ever folded away.
  const isExpanded =
    isFocusWithin
    || message.trim().length > 0
    || attachments.staged.length > 0
    || attachments.error !== null

  // Focus moving between the editor and a toolbar button must not collapse the
  // composer out from under the click, so this asks where focus went rather
  // than reacting to the editor losing it. A null target with the window itself
  // unfocused is the native file picker opening, not the person leaving.
  const handleBlur = (event: FocusEvent<HTMLFormElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    if (!next && !document.hasFocus()) return
    setIsFocusWithin(false)
  }

  return (
    // Base 14px padding plus the soft-keyboard inset (docs/navigation/overview.md
    // §4.14): the active composer stays above an on-screen keyboard instead
    // of sliding under it.
    <div
      className="flex-shrink-0 px-5"
      style={{ paddingBottom: 'calc(14px + var(--keyboard-inset, 0px))' }}
    >
      {pendingAgentInvites.length > 0 && (
        <div className="admin-card mb-2 flex flex-col gap-2 p-3">
          {pendingAgentInvites.map((agent) => (
            <div className="flex flex-col gap-1" key={agent.id}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="min-w-0 text-sm text-[color:var(--tx)]">
                  <span className="font-semibold text-[color:var(--accent)]">
                    @{agent.name}
                  </span>{' '}
                  isn’t in this channel yet. Invite it to answer this message.
                </span>
                <span className="flex flex-shrink-0 items-center gap-2">
                  <button
                    className="admin-button admin-button-primary"
                    disabled={invitingAgentId === agent.id}
                    onClick={() => onInvitePendingAgent(agent.id)}
                    type="button"
                  >
                    {invitingAgentId === agent.id
                      ? 'Inviting…'
                      : 'Invite & reply'}
                  </button>
                  <button
                    className="admin-button admin-button-secondary"
                    onClick={() => onDismissPendingAgent(agent.id)}
                    type="button"
                  >
                    Dismiss
                  </button>
                </span>
              </div>
              {inviteErrors[agent.id] && (
                <span
                  className="text-xs text-[color:var(--danger-text)]"
                  role="alert"
                >
                  {inviteErrors[agent.id]}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {sendError ? (
        <p className="mb-2 text-sm text-[color:var(--danger-text)]" role="alert">
          {sendError}
        </p>
      ) : null}
      <form
        className="admin-compose"
        data-expanded={isExpanded ? 'true' : 'false'}
        onBlur={handleBlur}
        onFocus={() => setIsFocusWithin(true)}
        onSubmit={onSubmitForm}
      >
        <MentionInput
          ref={mentionRef}
          entities={mentionEntities}
          maxLength={CHAT_MESSAGE_MAX_CHARS}
          onChange={onChangeMessage}
          onOversizePaste={onOversizePaste}
          onSubmit={onSubmitText}
          placeholder={placeholder}
        />
        <ComposerAttachments attachments={attachments} />
        <div className="admin-compose-bar">
          <div className="admin-compose-actions flex items-center gap-1">
            <button
              className={toolbarButtonClass}
              onClick={onInsertAtSign}
              title="Mention person or agent"
              type="button"
            >
              @
            </button>
            <button
              className={toolbarButtonClass}
              onClick={onInsertHashSign}
              title="Mention channel"
              type="button"
            >
              #
            </button>
            {onOpenDeepWaterResearch ? (
              <button
                aria-label="Start Deep Water research"
                className={toolbarButtonClass}
                onClick={onOpenDeepWaterResearch}
                title="Start Deep Water research"
                type="button"
              >
                <svg
                  className="admin-compose-action-icon h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <circle cx="11" cy="11" r="6" />
                  <path d="m16 16 4 4M11 8v6M8 11h6" strokeLinecap="round" />
                </svg>
              </button>
            ) : null}
            {onOpenExecutorRun ? (
              <button
                aria-label="Run on executor"
                className={toolbarButtonClass}
                onClick={onOpenExecutorRun}
                title="Run on executor"
                type="button"
              >
                <svg
                  className="admin-compose-action-icon h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M4 17V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
                  <path d="m8 8 3 3-3 3M13 14h3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : null}
            <ComposerEmojiButton onSelect={onInsertEmoji} />
            <button
              aria-label="Attach files"
              className={toolbarButtonClass}
              onClick={() => fileInputRef.current?.click()}
              title="Attach files"
              type="button"
            >
              <FontAwesomeIcon className="admin-compose-action-icon h-4 w-4" icon={faPaperclip} />
            </button>
            <input
              className="hidden"
              data-testid="composer-file-input"
              multiple
              onChange={(event) => {
                attachments.addFiles(Array.from(event.target.files ?? []))
                // Reset so picking the same file twice still fires a change.
                event.target.value = ''
              }}
              ref={fileInputRef}
              type="file"
            />
          </div>
        </div>
        {/* Pinned to the composer's bottom line rather than sitting in the
            toolbar, so Send holds its place on screen while the editor grows
            upward past it. */}
        <div className="admin-compose-send-slot">
          <button
            aria-label="Send message"
            className="admin-compose-send flex h-[30px] items-center justify-center rounded-lg bg-[color:var(--accent)] px-3 text-[var(--on-accent)] disabled:opacity-50"
            disabled={!canSend}
            type="submit"
          >
            <svg
              className="admin-compose-action-icon h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                d="m12 19 9 2-9-18-9 18 9-2Zm0 0v-8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </form>
      {secretCapture ? (
        <SecretCaptureDialog
          capture={secretCapture}
          onClose={onDismissSecretCapture}
          onSaved={onConfirmSecretCapture}
        />
      ) : null}
    </div>
  )
}
