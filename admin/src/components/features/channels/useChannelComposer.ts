import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CHAT_MESSAGE_MAX_CHARS, detectSecrets, type DetectedSecret } from '@nessie/schemas'
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
import { useComposerAttachments, type ComposerAttachments } from './useComposerAttachments'

interface UseChannelComposerParams {
  activeChannel: ChannelRecord | null
  threadMessages: ThreadMessageRecord[]
  currentUserId: string | undefined
  // Optional per-send extras (reply-thread routing, #233) read at send time so
  // the "Also send to channel" checkbox can toggle without re-wiring the hook.
  getSendExtras?: () => SendMessageThreadExtras
}

interface UseChannelComposerResult {
  message: string
  setMessage: React.Dispatch<React.SetStateAction<string>>
  optimisticMessages: OptimisticMessage[]
  oversizePaste: string | null
  setOversizePaste: React.Dispatch<React.SetStateAction<string | null>>
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
  dismissSecretCapture: () => void
}

export type SecretCapture = {
  detected: DetectedSecret
  scopeId?: string
  scopeType: 'personal' | 'project'
  value: string
}

export const useChannelComposer = ({
  activeChannel,
  threadMessages,
  currentUserId,
  getSendExtras,
}: UseChannelComposerParams): UseChannelComposerResult => {
  const sendMessage = useSendMessage(activeChannel?.defaultThreadId)
  const uploadAttachment = useUploadAttachment()
  const attachments = useComposerAttachments()
  const bindAgent = useBindAgent()
  const [message, setMessage] = useState('')
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([])
  const [oversizePaste, setOversizePaste] = useState<string | null>(null)
  const [pendingAgentInvites, setPendingAgentInvites] = useState<PendingAgentInvite[]>([])
  const [pendingInviteMessageIds, setPendingInviteMessageIds] = useState<Record<string, string>>({})
  const [invitingAgentId, setInvitingAgentId] = useState<string | null>(null)
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({})
  const [sendError, setSendError] = useState<string | null>(null)
  const [secretCapture, setSecretCapture] = useState<SecretCapture | null>(null)
  const mentionRef = useRef<MentionInputHandle>(null)

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
  }, [activeChannel?.id])

  const sendText = useCallback(
    async (rawText: string, agentMentions: PersonalAssistantMention[] = []) => {
      const text = rawText.trim()
      const attachmentIds = attachments.attachmentIds
      // A post needs text or at least one uploaded file (attachment-only send).
      if (!activeChannel || (!text && attachmentIds.length === 0)) {
        return
      }

      if (text.length > CHAT_MESSAGE_MAX_CHARS) {
        // Typed-past-the-limit path: show the same dialog so the user can
        // trim or cancel instead of getting a server 413 after the round
        // trip.
        setOversizePaste(text)
        return
      }

      const detected = detectSecrets(text)[0]
      if (detected) {
        // Stop before a request, optimistic row, browser notification, or
        // message-memory path can receive the material. The value stays only
        // in this protected capture state until the vault POST succeeds.
        setSecretCapture({
          detected,
          ...(activeChannel.projectId
            ? { scopeId: activeChannel.projectId, scopeType: 'project' as const }
            : { scopeType: 'personal' as const }),
          value: text.slice(detected.start, detected.end),
        })
        setMessage('')
        mentionRef.current?.clear()
        return
      }

      const clientId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`
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
          content: text,
          ...(agentMentions.length > 0 ? { agentMentions } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...getSendExtras?.(),
        })
        // Staged files are dropped only once they are safely linked, so a
        // failed send keeps them for a retry.
        attachments.clearStaged()
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
    [activeChannel, attachments, sendMessage, getSendExtras],
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
      const detected = detectSecrets(rawText)[0]
      if (detected) {
        setSecretCapture({
          detected,
          ...(activeChannel.projectId
            ? { scopeId: activeChannel.projectId, scopeType: 'project' as const }
            : { scopeType: 'personal' as const }),
          value: rawText.slice(detected.start, detected.end),
        })
        setOversizePaste(null)
        return
      }
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
        setOversizePaste(null)
      } catch (error) {
        setSendError(
          error instanceof Error && error.message
            ? error.message
            : 'Could not send this message. Please try again.',
        )
      }
    },
    [activeChannel, uploadAttachment, sendMessage, getSendExtras],
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
    dismissSecretCapture: () => setSecretCapture(null),
  }
}
