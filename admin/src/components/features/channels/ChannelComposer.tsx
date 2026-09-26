import { useState, useRef, type FocusEvent, type FormEvent, type ReactNode, type RefObject } from 'react'
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
import type { ResearchComposerButton } from '../deep-water/useResearchComposerButton'
import type { SecretRecord } from '../../../facades/secrets/hooks'
import { toolbarButtonClass } from './channel-presentation'
import { ComposerAttachments } from './ComposerAttachments'
import { ComposerEmojiButton } from './ComposerEmojiButton'
import { MentionInviteDialog } from './MentionInviteDialog'
import { SecretCaptureDialog } from './SecretCaptureDialog'
import type { SecretCapture } from './useChannelComposer'
import type { MentionInviteController } from './useMentionInviteGate'
import type { ComposerAttachments as ComposerAttachmentsState } from './useComposerAttachments'
import { VoiceDictationControl } from './VoiceDictationControl'
import { type VoiceDictationState, voiceDictationBlocksSubmit } from './voice-dictation-state'

interface ChannelComposerProps {
  mentionRef: RefObject<MentionInputHandle | null>
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
  // Required so no composer can hold a draft for a question it never shows.
  mentionInvite: MentionInviteController
  /** DeepWater research: always shown where a brief can open, with its reason. */
  researchButton?: ResearchComposerButton
  onOpenExecutorRun?: () => void
  /**
   * The holder's live executor lease, drawn beside Run on a computer. In the
   * toolbar, so it can never add a line to the composer at rest.
   */
  executorLeaseIndicator?: ReactNode
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
  mentionInvite,
  researchButton,
  onOpenExecutorRun,
  executorLeaseIndicator,
}: ChannelComposerProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isFocusWithin, setIsFocusWithin] = useState(false)
  const [voiceState, setVoiceState] = useState<VoiceDictationState>('idle')
  // Text or at least one finished upload, and never mid-upload.
  const canSend =
    (message.trim().length > 0 || attachments.attachmentIds.length > 0)
    && !attachments.isUploading
    && !isSendPending
    && !voiceDictationBlocksSubmit(voiceState)

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
    // of sliding under it. The third term is the installed Android shell's
    // floating dock, which overlays the page's own floor; it is zero in every
    // other shell and on the web, and it closes itself as that keyboard opens
    // (admin/src/styles.css, `--nessie-native-dock-clearance`). The installed
    // iPad shell lets the page reach the window floor, so the base padding
    // grows to the home indicator's inset there when that is larger
    // (`--nessie-native-home-clearance`); it is unset everywhere else.
    <div
      className="flex-shrink-0 px-5"
      style={{
        paddingBottom:
          'calc(max(14px, var(--nessie-native-home-clearance, 0px)) + var(--keyboard-inset, 0px) + var(--nessie-native-dock-clearance, 0px))',
      }}
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
        onSubmit={(event) => {
          if (voiceDictationBlocksSubmit(voiceState)) {
            event.preventDefault()
            return
          }
          onSubmitForm(event)
        }}
      >
        {/* A pasted screenshot is staged exactly like a picked file. Enter
            then sends it with no text, as Send does — but never while an
            upload is in flight, which would post without that file and drop
            it from the strip. */}
        <MentionInput
          ref={mentionRef}
          canSubmitEmpty={attachments.attachmentIds.length > 0}
          entities={mentionEntities}
          maxLength={CHAT_MESSAGE_MAX_CHARS}
          onChange={onChangeMessage}
          onOversizePaste={onOversizePaste}
          onPasteFiles={attachments.addFiles}
          onSubmit={onSubmitText}
          submitDisabled={voiceDictationBlocksSubmit(voiceState) || attachments.isUploading}
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
            {researchButton ? (
              <button
                aria-label={researchButton.title}
                className={toolbarButtonClass}
                data-testid="composer-research-button"
                onClick={researchButton.onOpen}
                title={researchButton.title}
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
                aria-label="Run on a computer"
                className={`${toolbarButtonClass} admin-compose-executor`}
                onClick={onOpenExecutorRun}
                title="Run on a computer"
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
            {executorLeaseIndicator}
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
          <VoiceDictationControl
            disabled={isSendPending}
            onInsertTranscript={(text) => {
              mentionRef.current?.insertDictationText(text)
              mentionRef.current?.focus()
            }}
            onStateChange={setVoiceState}
          />
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
      <MentionInviteDialog controller={mentionInvite} />
    </div>
  )
}
