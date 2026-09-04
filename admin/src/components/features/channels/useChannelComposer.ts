import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type { AgentMention, MentionInputHandle } from '../../shared/MentionInput'
import {
  useSendMessage,
  useUploadAttachment,
  type PendingAgentInvite,
  type SendMessageThreadExtras,
} from '../../../facades/messages/hooks'
import type { ChannelRecord, ThreadMessageRecord } from '../../../lib/api-client'
import type { OptimisticMessage } from './channel-helpers'
import { useDraft } from '../../../navigation/useDraft'
import {
  composerAttachmentIdsMatch,
  composerDraftIsEmpty,
  emptyComposerDraft,
  reviveComposerDraft,
  storableComposerAttachments,
  type ComposerDraft,
} from './composer-draft'
import { useComposerAttachments, type ComposerAttachments } from './useComposerAttachments'
import type { SecretRecord } from '../../../facades/secrets/hooks'
import { usePendingAgentInvites } from './usePendingAgentInvites'
import {
  advanceSecretCapture,
  createSecretCapture,
  protectedReplacement,
  type SecretCapture,
} from './secret-capture'

interface UseChannelComposerParams {
  activeChannel: ChannelRecord | null
  threadMessages: ThreadMessageRecord[]
  currentUserId: string | undefined
  // Optional per-send extras (reply-thread routing, #233) read at send time so
  // the "Also send to channel" checkbox can toggle without re-wiring the hook.
  getSendExtras?: () => SendMessageThreadExtras
  // `draft:composer:<channelId>` / `draft:reply:<rootMessageId>` — the entity
  // this composer belongs to. Null while it is not yet known; the composer then
  // keeps its state in memory only.
  draftKey: string | null
}

interface UseChannelComposerResult {
  message: string
  setMessage: React.Dispatch<React.SetStateAction<string>>
  optimisticMessages: OptimisticMessage[]
  oversizePaste: string | null
  setOversizePaste: (paste: string | null) => void
  mentionRef: React.RefObject<MentionInputHandle | null>
  isSendPending: boolean
  sendError: string | null
  // Files staged for the next send (paperclip + drag-and-drop).
  attachments: ComposerAttachments
  insertEmoji: (emoji: string) => void
  sendText: (rawText: string, agentMentions?: AgentMention[]) => Promise<void>
  sendMessageSubmit: (event?: FormEvent<HTMLFormElement>) => Promise<void>
  sendAsFile: (rawText: string) => Promise<void>
  pendingAgentInvites: PendingAgentInvite[]
  invitingAgentId: string | null
  inviteErrors: Record<string, string>
  invitePendingAgent: (agentId: string) => Promise<void>
  dismissPendingAgent: (agentId: string) => void
  secretCapture: SecretCapture | null
  confirmSecretCapture: (
    secret: SecretRecord,
    identity: { captureId: string; currentIndex: number },
  ) => Promise<void>
  dismissSecretCapture: () => void
}

const newClientMessageId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`

export const useChannelComposer = ({
  activeChannel,
  threadMessages,
  currentUserId,
  draftKey,
  getSendExtras,
}: UseChannelComposerParams): UseChannelComposerResult => {
  const sendMessage = useSendMessage(activeChannel?.defaultThreadId)
  const uploadAttachment = useUploadAttachment()
  const attachments = useComposerAttachments()
  // Drafts (docs/navigation/overview.md → "Drafts"): text and staged-attachment
  // metadata persist per entity, so switching channels can no longer carry one
  // conversation's unsent post into the next.
  const draft = useDraft<ComposerDraft>(draftKey, {
    initial: emptyComposerDraft,
    isEmpty: composerDraftIsEmpty,
    revive: reviveComposerDraft,
  })
  const message = draft.draft.text
  const setDraft = draft.setDraft
  const clearDraft = draft.clear
  const flushDraft = draft.flush
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([])
  const [oversizePaste, setOversizePasteState] = useState<string | null>(null)
  const {
    addPendingInvites,
    dismissPendingAgent,
    inviteErrors,
    invitePendingAgent,
    invitingAgentId,
    pendingAgentInvites,
  } = usePendingAgentInvites(activeChannel)
  const [sendError, setSendError] = useState<string | null>(null)
  const [secretCapture, setSecretCapture] = useState<SecretCapture | null>(null)
  const secretCaptureRef = useRef<SecretCapture | null>(null)
  const mentionRef = useRef<MentionInputHandle>(null)
  // One idempotency key per unsent draft. It is minted at the first attempt and
  // retained while that attempt is unresolved, so a double-submit or a client
  // retry of the same post resolves to the message the first attempt created
  // rather than a second copy; a success mints a fresh one for the next post.
  const clientMessageIdRef = useRef<string | null>(null)
  const activeChannelIdRef = useRef(activeChannel?.id)
  activeChannelIdRef.current = activeChannel?.id
  const pendingFileRef = useRef<{ filename: string; id: string; source: string } | null>(null)

  const storeSecretCapture = useCallback((capture: SecretCapture | null) => {
    secretCaptureRef.current = capture
    setSecretCapture(capture)
  }, [])

  const setMessage = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (value) => {
      setDraft((current) => ({
        ...current,
        text: typeof value === 'function' ? value(current.text) : value,
      }))
    },
    [setDraft],
  )

  // The composer's editor is uncontrolled, so it is repainted only when the
  // draft was replaced by the hook itself (a channel switch, a restore, a
  // send) — `revision`, never the text, which typing changes on every key.
  const { revision: draftRevision } = draft
  const draftValue = draft.draft
  const restoreStaged = attachments.restoreStaged
  useEffect(() => {
    mentionRef.current?.setText(draftValue.text)
    restoreStaged(draftValue.attachments)
    // Reacting to the draft's own replacements only; `draftValue` is read at
    // that render and must not re-trigger this on a keystroke.
  }, [draftRevision])

  // Finished uploads flow the other way, so a reload re-stages the same files.
  const stagedAttachments = attachments.staged
  useEffect(() => {
    const storable = storableComposerAttachments(stagedAttachments)
    setDraft((current) =>
      composerAttachmentIdsMatch(current.attachments, storable)
        ? current
        : { ...current, attachments: storable })
  }, [stagedAttachments])

  // Clear optimistic bubble once the real message from the server arrives.
  // Match on content + proximity: any optimistic entry whose content equals
  // a persisted user message can be dropped.
  useEffect(() => {
    if (optimisticMessages.length === 0) return
    const persistedContents = new Set(
      threadMessages
        .filter((m) => m.role === 'user' && m.userId === currentUserId)
        .map((m) => m.content),
    )
    if ([...optimisticMessages].some((o) => persistedContents.has(o.content))) {
      setOptimisticMessages((current) =>
        current.filter((o) => !persistedContents.has(o.content) || o.status === 'failed'),
      )
    }
  }, [threadMessages, optimisticMessages, currentUserId])

  // Reset optimistic + pending-invite state when switching channels.
  useEffect(() => {
    setOptimisticMessages([])
    setSendError(null)
    setOversizePasteState(null)
    storeSecretCapture(null)
    // A different conversation is a different post: never carry one channel's
    // idempotency key into the next.
    clientMessageIdRef.current = null
    pendingFileRef.current = null
  }, [activeChannel?.id, storeSecretCapture])

  const postSafeText = useCallback(
    async (
      text: string,
      agentMentions: AgentMention[],
      attachmentIds: string[],
    ) => {
      if (!activeChannel || (!text && attachmentIds.length === 0)) return
      const targetChannelId = activeChannel.id
      const clientId = newClientMessageId()
      clientMessageIdRef.current ??= newClientMessageId()
      const clientMessageId = clientMessageIdRef.current
      // An attachment-only post has no text to echo, so it skips the optimistic
      // bubble and appears on the refetch the send triggers.
      if (text) {
        const optimistic: OptimisticMessage = {
          clientId,
          content: text,
          createdAt: new Date().toISOString(),
          status: 'sending',
        }
        setOptimisticMessages((current) => [...current, optimistic])
      }
      setMessage('')
      mentionRef.current?.clear()
      setSendError(null)

      try {
        const result = await sendMessage.mutateAsync({
          clientMessageId,
          content: text,
          ...(agentMentions.length > 0 ? { agentMentions } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...getSendExtras?.(),
        })
        // Staged files are dropped only once they are safely linked, so a
        // failed send keeps them for a retry. The draft goes with them: a sent
        // message is no longer unsent.
        if (activeChannelIdRef.current === targetChannelId) {
          attachments.clearStaged()
          clearDraft()
          clientMessageIdRef.current = null
        }
        // Surface @mentioned agents that aren't members of this channel so the
        // user can invite them; they were not dispatched.
        if (
          activeChannelIdRef.current === targetChannelId
          && result.pendingAgentInvites.length > 0
        ) {
          addPendingInvites(result.pendingAgentInvites, result.message.id)
        }
      } catch (error) {
        if (activeChannelIdRef.current !== targetChannelId) throw error
        setOptimisticMessages((current) =>
          current.map((entry) =>
            entry.clientId === clientId ? { ...entry, status: 'failed' } : entry,
          ),
        )
        setSendError(
          error instanceof Error && error.message
            ? error.message
            : 'Could not send this message. Please try again.',
        )
        throw error
      }
    },
    [activeChannel, addPendingInvites, attachments, clearDraft, sendMessage, getSendExtras],
  )

  const captureSecretText = useCallback((input: {
    agentMentions?: AgentMention[]
    attachmentIds?: string[]
    clearComposer?: boolean
    content: string
    replacementMode?: SecretCapture['replacementMode']
  }): boolean => {
    const { clearComposer = true, ...captureInput } = input
    const capture = createSecretCapture({
      ...captureInput,
      projectId: activeChannel?.projectId,
    })
    if (!capture) return false
    storeSecretCapture(capture)
    if (!clearComposer) return true
    // Replace the draft with attachment metadata only. The credential-aware
    // draft predicate removes any already-written text and no raw message is
    // left behind for a later restore.
    setDraft((current) => ({ ...current, text: '' }))
    // Remove any earlier, not-yet-recognizable prefix synchronously instead of
    // waiting for the draft debounce after a complete credential is found.
    void flushDraft()
    mentionRef.current?.clear()
    return true
  }, [activeChannel?.projectId, flushDraft, setDraft, storeSecretCapture])

  const setOversizePaste = useCallback((paste: string | null) => {
    if (paste && captureSecretText({
      clearComposer: false,
      content: paste,
      replacementMode: 'file',
    })) {
      setOversizePasteState(null)
      return
    }
    setOversizePasteState(paste)
  }, [captureSecretText])

  const sendText = useCallback(
    async (rawText: string, agentMentions: AgentMention[] = []) => {
      if (attachments.isUploading || sendMessage.isPending) return
      const text = rawText.trim()
      const attachmentIds = attachments.attachmentIds
      if (!activeChannel || (!text && attachmentIds.length === 0)) return

      if (captureSecretText({
        agentMentions,
        attachmentIds,
        content: text,
        replacementMode: text.length > CHAT_MESSAGE_MAX_CHARS ? 'file' : 'message',
      })) return
      if (text.length > CHAT_MESSAGE_MAX_CHARS) {
        setOversizePasteState(text)
        return
      }
      try {
        await postSafeText(text, agentMentions, attachmentIds)
      } catch {
        // postSafeText owns the visible failed bubble and error message.
      }
    },
    [
      activeChannel,
      attachments.attachmentIds,
      attachments.isUploading,
      captureSecretText,
      postSafeText,
      sendMessage.isPending,
    ],
  )

  const insertEmoji = useCallback((emoji: string) => {
    mentionRef.current?.insertText(emoji)
    mentionRef.current?.focus()
  }, [])

  const sendMessageSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (attachments.isUploading || sendMessage.isPending) return
    const text = mentionRef.current?.getText() ?? message
    const agentMentions = mentionRef.current?.getAgentMentions() ?? []
    // Clear synchronously before awaiting the network mutation so a
    // second submit (double-enter, double-click) can't re-read the
    // same contentEditable text.
    mentionRef.current?.clear()
    await sendText(text, agentMentions)
  }

  // Oversize escape hatch: upload the whole paste as a .txt attachment and
  // post it as a message referencing the uploaded file.
  const sendAsFile = useCallback(
    async (rawText: string) => {
      if (!activeChannel) {
        return
      }
      const accompanyingText = message.trim()
      if (accompanyingText && captureSecretText({
        content: accompanyingText,
        replacementMode: 'message',
      })) return
      if (captureSecretText({
        clearComposer: false,
        content: rawText,
        replacementMode: 'file',
      })) return
      setSendError(null)
      try {
        let attachment = pendingFileRef.current?.source === rawText
          ? pendingFileRef.current
          : null
        if (!attachment) {
          const file = new File([rawText], 'pasted-text.txt', { type: 'text/plain' })
          const uploaded = await uploadAttachment.mutateAsync(file)
          attachment = { filename: uploaded.filename, id: uploaded.id, source: rawText }
          pendingFileRef.current = attachment
        }
        const agentMentions = mentionRef.current?.getAgentMentions() ?? []
        await postSafeText(
          accompanyingText || `Shared file: ${attachment.filename}`,
          accompanyingText ? agentMentions : [],
          [attachment.id],
        )
        pendingFileRef.current = null
        setOversizePasteState(null)
      } catch (error) {
        setSendError(
          error instanceof Error && error.message
            ? error.message
            : 'Could not send this message. Please try again.',
        )
        throw error
      }
    },
    [
      activeChannel,
      captureSecretText,
      message,
      postSafeText,
      uploadAttachment,
    ],
  )

  const confirmSecretCapture = useCallback(
    async (
      secret: SecretRecord,
      identity: { captureId: string; currentIndex: number },
    ) => {
      const capture = secretCaptureRef.current
      if (
        !capture
        || capture.captureId !== identity.captureId
        || capture.currentIndex !== identity.currentIndex
      ) return

      const next = advanceSecretCapture(capture, secret.name)
      if (next) {
        storeSecretCapture(next)
        return
      }

      // Chat work sees only the scanner-produced replacement and non-secret
      // names. Keep the dialog mounted until that safe send succeeds so a
      // failed send can retry without writing the vault value a second time.
      const replacement = protectedReplacement(capture, secret.name)

      if (capture.replacementMode === 'file') {
        await sendAsFile(replacement)
      } else {
        await postSafeText(replacement, capture.agentMentions, capture.attachmentIds)
      }
      if (secretCaptureRef.current?.captureId === capture.captureId) {
        storeSecretCapture(null)
      }
    },
    [postSafeText, sendAsFile, storeSecretCapture],
  )

  return {
    message,
    setMessage,
    optimisticMessages,
    oversizePaste,
    setOversizePaste,
    mentionRef,
    isSendPending: sendMessage.isPending || attachments.isUploading,
    sendError,
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
    secretCapture,
    confirmSecretCapture,
    dismissSecretCapture: () => storeSecretCapture(null),
  }
}
