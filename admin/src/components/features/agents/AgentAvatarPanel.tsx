import { useState } from 'react'
import { useUpdateAgentAvatar } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { uploadAttachment } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { AvatarUploadPanel } from '../../shared/AvatarUploadPanel'

type AgentAvatarPanelProps = {
  agent: AgentRecord
}

const sourceHint = (hasCustom: boolean): string =>
  hasCustom
    ? "Using this agent's uploaded avatar. Remove it to fall back to the generated glyph."
    : 'Using a generated agent glyph. Upload an avatar to personalize this agent.'

export const AgentAvatarPanel = ({ agent }: AgentAvatarPanelProps) => {
  const { token } = useAuthSession()
  const updateAvatar = useUpdateAgentAvatar()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasCustom = Boolean(agent.avatarAttachmentId)
  const busy = uploading || updateAvatar.isPending

  const handleSave = async (blob: Blob) => {
    setUploading(true)
    setError(null)
    try {
      const file = new File([blob], 'agent-avatar.png', { type: 'image/png' })
      const attachment = await uploadAttachment(file, token)
      await updateAvatar.mutateAsync({
        agentId: agent.id,
        avatarAttachmentId: attachment.id,
      })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save avatar')
      throw saveError
    } finally {
      setUploading(false)
    }
  }

  const handleRemove = () => {
    setError(null)
    updateAvatar.mutate(
      { agentId: agent.id, avatarAttachmentId: null },
      {
        onError: (removeError) =>
          setError(removeError instanceof Error ? removeError.message : 'Failed to remove avatar'),
      },
    )
  }

  return (
    <AvatarUploadPanel
      busy={busy}
      cropperDescription="Drag to reposition, scroll or use the slider to zoom. The circle becomes this agent avatar."
      cropperTitle="Edit agent avatar"
      error={error}
      hasCustom={hasCustom}
      hint={sourceHint(hasCustom)}
      preview={
        <AgentAvatar
          agent={agent}
          className="border border-[color:var(--sep)]"
          shape="circle"
          size="xl"
          token={token}
        />
      }
      replaceLabel="Replace avatar"
      saveLabel="Save avatar"
      title="Agent avatar"
      uploadLabel="Upload avatar"
      onRemove={handleRemove}
      onSave={handleSave}
    />
  )
}
