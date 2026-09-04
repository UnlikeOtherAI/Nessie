import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'

import type { MentionInputHandle } from '../../components/shared/MentionInput'
import {
  advanceSecretCapture,
  createSecretCapture,
  protectedReplacement,
  type SecretCapture,
} from '../../components/features/channels/secret-capture'
import { useStartChannelConversation } from '../../facades/channels/hooks'
import { useSendMessageToThread, useUploadAttachment } from '../../facades/messages/hooks'
import type { SecretRecord } from '../../facades/secrets/hooks'
import type { Recipient } from '../../lib/channel-compose-recipients'

const newClientMessageId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`

export const useNewChannelConversationSend = (recipients: Recipient[]) => {
  const navigate = useNavigate()
  const startConversation = useStartChannelConversation()
  const sendMessage = useSendMessageToThread()
  const uploadAttachment = useUploadAttachment()
  const mentionRef = useRef<MentionInputHandle>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oversizePaste, setOversizePaste] = useState<string | null>(null)
  const [secretCapture, setSecretCapture] = useState<SecretCapture | null>(null)
  const secretCaptureRef = useRef<SecretCapture | null>(null)
  const clientMessageIdRef = useRef<string | null>(null)
  const pendingChannelRef = useRef<{
    defaultThreadId: string
    id: string
    recipientsKey: string
  } | null>(null)
  const pendingFileRef = useRef<{ filename: string; id: string; source: string } | null>(null)

  const storeSecretCapture = useCallback((capture: SecretCapture | null) => {
    secretCaptureRef.current = capture
    setSecretCapture(capture)
  }, [])

  const clearComposer = useCallback(() => {
    mentionRef.current?.clear()
    setMessage('')
  }, [])

  const postSafeText = useCallback(async (
    content: string,
    attachmentIds: string[] = [],
  ) => {
    const recipientsKey = recipients
      .map((recipient) => `${recipient.kind}:${recipient.id}`)
      .sort()
      .join('|')
    let channel = pendingChannelRef.current?.recipientsKey === recipientsKey
      ? pendingChannelRef.current
      : null
    if (!channel) {
      const created = await startConversation.mutateAsync({
        agentIds: recipients
          .filter((recipient) => recipient.kind === 'agent')
          .map((recipient) => recipient.id),
        userIds: recipients
          .filter((recipient) => recipient.kind === 'user')
          .map((recipient) => recipient.id),
      })
      channel = {
        defaultThreadId: created.defaultThreadId,
        id: created.id,
        recipientsKey,
      }
      pendingChannelRef.current = channel
    }
    clientMessageIdRef.current ??= newClientMessageId()
    await sendMessage.mutateAsync({
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      clientMessageId: clientMessageIdRef.current,
      content,
      threadId: channel.defaultThreadId,
    })
    clientMessageIdRef.current = null
    pendingChannelRef.current = null
    clearComposer()
    void navigate(`/channels/${channel.id}`, { replace: true })
  }, [clearComposer, navigate, recipients, sendMessage, startConversation])

  const requireRecipient = useCallback((): boolean => {
    if (recipients.length > 0) return true
    setError('Choose at least one recipient.')
    return false
  }, [recipients.length])

  const sendAsFile = useCallback(async (rawText: string) => {
    if (!requireRecipient()) {
      throw new Error('Choose at least one recipient before sending the file.')
    }
    const accompanyingCapture = createSecretCapture({
      content: message.trim(),
      replacementMode: 'message',
    })
    if (accompanyingCapture) {
      storeSecretCapture(accompanyingCapture)
      clearComposer()
      return
    }
    const capture = createSecretCapture({ content: rawText, replacementMode: 'file' })
    if (capture) {
      setOversizePaste(null)
      storeSecretCapture(capture)
      return
    }
    setError(null)
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
      await postSafeText(message.trim() || `Shared file: ${attachment.filename}`, [attachment.id])
      pendingFileRef.current = null
      setOversizePaste(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start chat.')
      throw caught
    }
  }, [
    clearComposer,
    message,
    postSafeText,
    requireRecipient,
    storeSecretCapture,
    uploadAttachment,
  ])

  const submit = useCallback(async (rawText: string) => {
    const content = rawText.trim()
    if (!content || !requireRecipient()) return

    const capture = createSecretCapture({
      content,
      replacementMode: content.length > CHAT_MESSAGE_MAX_CHARS ? 'file' : 'message',
    })
    if (capture) {
      storeSecretCapture(capture)
      clearComposer()
      return
    }
    if (content.length > CHAT_MESSAGE_MAX_CHARS) {
      setOversizePaste(content)
      return
    }

    setError(null)
    try {
      await postSafeText(content)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start chat.')
    }
  }, [clearComposer, postSafeText, requireRecipient, storeSecretCapture])

  const captureOversizePaste = useCallback((paste: string) => {
    const capture = createSecretCapture({ content: paste, replacementMode: 'file' })
    if (!capture) {
      setOversizePaste(paste)
      return
    }
    setOversizePaste(null)
    storeSecretCapture(capture)
  }, [storeSecretCapture])

  const confirmSecretCapture = useCallback(async (
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
    const replacement = protectedReplacement(capture, secret.name)
    if (capture.replacementMode === 'file') {
      await sendAsFile(replacement)
    } else {
      await postSafeText(replacement)
    }
    if (secretCaptureRef.current?.captureId === capture.captureId) {
      storeSecretCapture(null)
    }
  }, [postSafeText, sendAsFile, storeSecretCapture])

  return {
    captureOversizePaste,
    confirmSecretCapture,
    dismissSecretCapture: () => storeSecretCapture(null),
    error,
    isPending: startConversation.isPending
      || sendMessage.isPending
      || uploadAttachment.isPending,
    mentionRef,
    message,
    oversizePaste,
    secretCapture,
    sendAsFile,
    setMessage,
    setOversizePaste,
    submit,
  }
}
