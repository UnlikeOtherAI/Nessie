import { useState } from 'react'
import {
  useGenerateAgentAvatar,
  useUpdateAgentAvatar,
} from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { uploadAttachment } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

type AgentAvatarContext = {
  name: string
  role: string
  systemPrompt: string
}

export type GeneratedAgentAvatar = {
  avatarAttachmentId: string
  avatarBackgroundColor: NonNullable<AgentRecord['avatarBackgroundColor']>
}

const messageFor = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

// Both the full Agent Designer panel and the compact settings control use this
// one mutation flow. That keeps uploads, generation previews, and the PATCH
// confirmation endpoint consistent whichever doorway an owner uses.
export const useAgentAvatarChanges = (
  agentId: string,
  avatarContext?: AgentAvatarContext,
) => {
  const { token } = useAuthSession()
  const updateAvatar = useUpdateAgentAvatar()
  const generateAvatar = useGenerateAgentAvatar()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = async (blob: Blob) => {
    setUploading(true)
    setError(null)
    try {
      const attachment = await uploadAttachment(
        new File([blob], 'agent-avatar.png', { type: 'image/png' }),
        token,
      )
      await updateAvatar.mutateAsync({
        agentId,
        avatarAttachmentId: attachment.id,
      })
    } catch (uploadError) {
      setError(messageFor(uploadError, 'Failed to save avatar'))
      throw uploadError
    } finally {
      setUploading(false)
    }
  }

  const generate = async (
    instructions?: string,
  ): Promise<GeneratedAgentAvatar | null> => {
    setError(null)
    try {
      return await generateAvatar.mutateAsync({
        agentId,
        ...avatarContext,
        instructions: instructions?.trim() || undefined,
      })
    } catch (generationError) {
      setError(messageFor(generationError, 'Failed to generate a headshot'))
      return null
    }
  }

  const replace = async (generatedAvatar: GeneratedAgentAvatar): Promise<boolean> => {
    setError(null)
    try {
      await updateAvatar.mutateAsync({ agentId, ...generatedAvatar })
      return true
    } catch (replacementError) {
      setError(messageFor(replacementError, 'Failed to replace avatar'))
      return false
    }
  }

  const remove = async () => {
    setError(null)
    try {
      await updateAvatar.mutateAsync({ agentId, avatarAttachmentId: null })
    } catch (removeError) {
      setError(messageFor(removeError, 'Failed to remove avatar'))
    }
  }

  return {
    busy: uploading || updateAvatar.isPending || generateAvatar.isPending,
    clearError: () => setError(null),
    error,
    generate,
    isGenerating: generateAvatar.isPending,
    isReplacing: updateAvatar.isPending,
    remove,
    replace,
    upload,
  }
}
