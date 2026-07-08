import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type { MentionInputHandle } from '../../shared/MentionInput'
import {
  useSendMessage,
  useUploadAttachment,
  type PendingAgentInvite,
} from '../../../facades/messages/hooks'
import { useBindAgent } from '../../../facades/agents/hooks'
import type { ChannelRecord, ThreadMessageRecord } from '../../../lib/api-client'
import type { OptimisticMessage } from './channel-helpers'

interface UseChannelComposerParams {
  activeChannel: ChannelRecord | null
  threadMessages: ThreadMessageRecord[]
  currentUserId: string | undefined
}

interface UseChannelComposerResult {
  message: string
  setMessage: React.Dispatch<React.SetStateAction<string>>
  optimisticMessages: OptimisticMessage[]
  oversizePaste: string | null
  setOversizePaste: React.Dispatch<React.SetStateAction<string | null>>
  mentionRef: React.RefObject<MentionInputHandle | null>
  isSendPending: boolean
  sendText: (rawText: string) => Promise<void>
  sendMessageSubmit: (event?: FormEvent<HTMLFormElement>) => Promise<void>
  sendAsFile: (rawText: string) => Promise<void>
  pendingAgentInvites: PendingAgentInvite[]
  invitingAgentId: string | null
  inviteErrors: Record<string, string>
  invitePendingAgent: (agentId: string) => Promise<void>
  dismissPendingAgent: (agentId: string) => void
}

export const useChannelComposer = ({
  activeChannel,
  threadMessages,
  currentUserId,
}: UseChannelComposerParams): UseChannelComposerResult => {
  const sendMessage = useSendMessage(activeChannel?.defaultThreadId)
  const uploadAttachment = useUploadAttachment()
  const bindAgent = useBindAgent()
  const [message, setMessage] = useState('')
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([])
  const [oversizePaste, setOversizePaste] = useState<string | null>(null)
  const [pendingAgentInvites, setPendingAgentInvites] = useState<PendingAgentInvite[]>([])
  const [invitingAgentId, setInvitingAgentId] = useState<string | null>(null)
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({})
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
    setInviteErrors({})
  }, [activeChannel?.id])

  const sendText = useCallback(
    async (rawText: string) => {
      const text = rawText.trim()
      if (!activeChannel || !text) {
        return
      }

      if (text.length > CHAT_MESSAGE_MAX_CHARS) {
        // Typed-past-the-limit path: show the same dialog so the user can
        // trim or cancel instead of getting a server 413 after the round
        // trip.
        setOversizePaste(text)
        return
      }

      const clientId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`
      const optimistic: OptimisticMessage = {
        clientId,
        content: text,
        createdAt: new Date().toISOString(),
        status: 'sending',
      }
      setOptimisticMessages((current) => [...current, optimistic])
      setMessage('')
      mentionRef.current?.clear()

      try {
        const result = await sendMessage.mutateAsync({ content: text })
        // Surface @mentioned agents that aren't members of this channel so the
        // user can invite them; they were not dispatched.
        if (result.pendingAgentInvites.length > 0) {
          setPendingAgentInvites((current) => {
            const seen = new Set(current.map((a) => a.id))
            return [...current, ...result.pendingAgentInvites.filter((a) => !seen.has(a.id))]
          })
        }
      } catch {
        setOptimisticMessages((current) =>
          current.map((entry) =>
            entry.clientId === clientId ? { ...entry, status: 'failed' } : entry,
          ),
        )
      }
    },
    [activeChannel, sendMessage],
  )

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
        await bindAgent.mutateAsync({ agentId, channelId: activeChannel.id })
        setPendingAgentInvites((current) => current.filter((a) => a.id !== agentId))
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
    [activeChannel, bindAgent],
  )

  const sendMessageSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    const text = mentionRef.current?.getText() ?? message
    // Clear synchronously before awaiting the network mutation so a
    // second submit (double-enter, double-click) can't re-read the
    // same contentEditable text.
    mentionRef.current?.clear()
    await sendText(text)
  }

  // Oversize escape hatch: upload the whole paste as a .txt attachment and
  // post it as a message referencing the uploaded file.
  const sendAsFile = useCallback(
    async (rawText: string) => {
      if (!activeChannel) {
        return
      }
      const file = new File([rawText], 'pasted-text.txt', { type: 'text/plain' })
      const attachment = await uploadAttachment.mutateAsync(file)
      await sendMessage.mutateAsync({
        attachmentIds: [attachment.id],
        content: `Shared file: ${attachment.filename}`,
      })
      setOversizePaste(null)
    },
    [activeChannel, uploadAttachment, sendMessage],
  )

  return {
    message,
    setMessage,
    optimisticMessages,
    oversizePaste,
    setOversizePaste,
    mentionRef,
    isSendPending: sendMessage.isPending,
    sendText,
    sendMessageSubmit,
    sendAsFile,
    pendingAgentInvites,
    invitingAgentId,
    inviteErrors,
    invitePendingAgent,
    dismissPendingAgent,
  }
}
