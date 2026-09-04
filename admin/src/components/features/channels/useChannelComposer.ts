import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type { MentionInputHandle, PersonalAssistantMention } from '../../shared/MentionInput'
import {
  useSendMessage,
  useUploadAttachment,
  type PendingAgentInvite,
  type SendMessageThreadExtras,
} from '../../../facades/messages/hooks'
import { useBindAgent } from '../../../facades/agents/hooks'
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
  sendText: (rawText: string, agentMentions?: PersonalAssistantMention[]) => Promise<void>
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
  const bindAgent = useBindAgent()
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
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([])
  const [oversizePaste, setOversizePasteState] = useState<string | null>(null)
  const [pendingAgentInvites, setPendingAgentInvites] = useState<PendingAgentInvite[]>([])
  const [pendingInviteMessageIds, setPendingInviteMessageIds] = useState<Record<string, string>>({})
  const [invitingAgentId, setInvitingAgentId] = useState<string | null>(null)
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({})
  const [sendError, setSendError] = useState<string | null>(null)
  const [secretCapture, setSecretCapture] = useState<SecretCapture | null>(null)
  const secretCaptureRef = useRef<SecretCapture | null>(null)
  const mentionRef = useRef<MentionInputHandle>(null)
  // One idempotency key per unsent draft. It is minted at the first attempt and
  // retained while that attempt is unresolved, so a double-submit or a client
  // retry of the same post resolves to the message the first attempt created
  // rather than a second copy; a success mints a fresh one for the next post.
  const clientMessageIdRef = useRef<string | null>(null)

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
    setPendingAgentInvites([])
    setPendingInviteMessageIds({})
    setInviteErrors({})
    setSendError(null)
    setOversizePasteState(null)
    storeSecretCapture(null)
    // A different conversation is a different post: never carry one channel's
    // idempotency key into the next.
    clientMessageIdRef.current = null
  }, [activeChannel?.id, storeSecretCapture])

  const postSafeText = useCallback(
    async (
      text: string,
      agentMentions: PersonalAssistantMention[],
      attachmentIds: string[],
    ) => {
      if (!activeChannel || (!text && attachmentIds.length === 0)) return
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
        attachments.clearStaged()
        clearDraft()
        clientMessageIdRef.current = null
        // Surface @mentioned agents that aren't members of this channel so the
        // user can invite them; they were not dispatched.
        if (result.pendingAgentInvites.length > 0) {
          setPendingAgentInvites((current) => {
            const seen = new Set(current.map((a) => a.id))
            return [...current, ...result.pendingAgentInvites.filter((a) => !seen.has(a.id))]
          })
          setPendingInviteMessageIds((current) => {
            const next = { ...current }
            for (const agent of result.pendingAgentInvites) {
              next[agent.id] ??= result.message.id
            }
            return next
          })
        }
      } catch (error) {
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
      }
    },
    [activeChannel, attachments, clearDraft, sendMessage, getSendExtras],
  )

  const captureSecretText = useCallback((input: {
    agentMentions?: PersonalAssistantMention[]
    attachmentIds?: string[]
    content: string
    replacementMode?: SecretCapture['replacementMode']
  }): boolean => {
    const capture = createSecretCapture({
      ...input,
      projectId: activeChannel?.projectId,
    })
    if (!capture) return false
    storeSecretCapture(capture)
    // Replace the draft with attachment metadata only. The credential-aware
    // draft predicate removes any already-written text and no raw message is
    // left behind for a later restore.
    setDraft((current) => ({ ...current, text: '' }))
    mentionRef.current?.clear()
    return true
  }, [activeChannel?.projectId, setDraft, storeSecretCapture])

  const setOversizePaste = useCallback((paste: string | null) => {
    if (paste && captureSecretText({ content: paste, replacementMode: 'file' })) {
      setOversizePasteState(null)
      return
    }
    setOversizePasteState(paste)
  }, [captureSecretText])

  const sendText = useCallback(
    async (rawText: string, agentMentions: PersonalAssistantMention[] = []) => {
      const text = rawText.trim()
      const attachmentIds = attachments.attachmentIds
      if (!activeChannel || (!text && attachmentIds.length === 0)) return

      if (captureSecretText({ agentMentions, attachmentIds, content: text })) return
      if (text.length > CHAT_MESSAGE_MAX_CHARS) {
        setOversizePasteState(text)
        return
      }
      await postSafeText(text, agentMentions, attachmentIds)
    },
    [activeChannel, attachments.attachmentIds, captureSecretText, postSafeText],
  )

  const insertEmoji = useCallback((emoji: string) => {
    mentionRef.current?.insertText(emoji)
    mentionRef.current?.focus()
  }, [])

  const clearInviteError = (agentId: string) =>
    setInviteErrors((current) => {
      if (!(agentId in current)) {
        return current
      }
      const next = { ...current }
      delete next[agentId]
      return next
    })

  const dismissPendingAgent = useCallback((agentId: string) => {
    setPendingAgentInvites((current) => current.filter((a) => a.id !== agentId))
    setPendingInviteMessageIds((current) => {
      const next = { ...current }
      delete next[agentId]
      return next
    })
    clearInviteError(agentId)
  }, [])

  const invitePendingAgent = useCallback(
    async (agentId: string) => {
      if (!activeChannel) {
        return
      }
      setInvitingAgentId(agentId)
      clearInviteError(agentId)
      try {
        const triggerMessageId = pendingInviteMessageIds[agentId]
        await bindAgent.mutateAsync({
          agentId,
          channelId: activeChannel.id,
          ...(triggerMessageId ? { triggerMessageId } : {}),
        })
        setPendingAgentInvites((current) => current.filter((a) => a.id !== agentId))
        setPendingInviteMessageIds((current) => {
          const next = { ...current }
          delete next[agentId]
          return next
        })
      } catch (error) {
        setInviteErrors((current) => ({
          ...current,
          [agentId]:
            error instanceof Error && error.message
              ? error.message
              : 'Could not invite this agent. Please try again.',
        }))
      } finally {
        setInvitingAgentId(null)
      }
    },
    [activeChannel, bindAgent, pendingInviteMessageIds],
  )

  const sendMessageSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
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
      if (captureSecretText({ content: rawText, replacementMode: 'file' })) return
      setSendError(null)
      try {
        const file = new File([rawText], 'pasted-text.txt', { type: 'text/plain' })
        const attachment = await uploadAttachment.mutateAsync(file)
        await sendMessage.mutateAsync({
          attachmentIds: [attachment.id],
          content: `Shared file: ${attachment.filename}`,
          // Same routing as a typed reply — without this the escape hatch posted
          // to the channel instead of into the open reply thread.
          ...getSendExtras?.(),
        })
        clearDraft()
        setOversizePasteState(null)
      } catch (error) {
        setSendError(
          error instanceof Error && error.message
            ? error.message
            : 'Could not send this message. Please try again.',
        )
      }
    },
    [activeChannel, captureSecretText, clearDraft, uploadAttachment, sendMessage, getSendExtras],
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

      // Drop every raw value before chat work. The follow-up contains only the
      // scanner-produced replacement and the non-secret names the person chose.
      storeSecretCapture(null)
      const replacement = protectedReplacement(capture, secret.name)

      if (capture.replacementMode === 'file') {
        await sendAsFile(replacement)
        return
      }
      await postSafeText(replacement, capture.agentMentions, capture.attachmentIds)
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
    isSendPending: sendMessage.isPending,
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
