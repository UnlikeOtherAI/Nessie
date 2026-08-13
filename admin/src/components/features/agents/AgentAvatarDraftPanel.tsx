import { useState } from 'react'

import { uploadAttachment } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { AvatarUploadPanel } from '../../shared/AvatarUploadPanel'

type AgentAvatarDraftPanelProps = {
  avatarAttachmentId: string | undefined
  name: string
  onAvatarAttachmentChange: (attachmentId: string | undefined) => void
  role: string
}

/** Upload before creation so the ordinary create route can publish the image atomically. */
export const AgentAvatarDraftPanel = ({
  avatarAttachmentId,
  name,
  onAvatarAttachmentChange,
  role,
}: AgentAvatarDraftPanelProps) => {
  const { token } = useAuthSession()
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const draftAgent = { avatarAttachmentId, id: 'new-agent', name, role }

  const handleSave = async (blob: Blob) => {
    setError(null)
    setUploading(true)
    try {
      const attachment = await uploadAttachment(
        new File([blob], 'agent-avatar.png', { type: 'image/png' }),
        token,
      )
      onAvatarAttachmentChange(attachment.id)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Failed to upload avatar')
      throw uploadError
    } finally {
      setUploading(false)
    }
  }

  return (
    <AvatarUploadPanel
      busy={uploading}
      cropperDescription="Drag to reposition, scroll or use the slider to zoom. The circle becomes this agent avatar."
      cropperTitle="Edit agent avatar"
      error={error}
      hasCustom={Boolean(avatarAttachmentId)}
      hint="Optional. Leave this blank and Nessie will create a cartoon headshot through Ledger when you create the agent."
      preview={
        <AgentAvatar
          agent={draftAgent}
          className="border border-[color:var(--sep)]"
          shape="circle"
          size="xl"
          token={token}
        />
      }
      replaceLabel="Replace avatar"
      saveLabel="Use avatar"
      title="Agent avatar"
      uploadLabel="Upload avatar"
      onRemove={() => onAvatarAttachmentChange(undefined)}
      onSave={handleSave}
    />
  )
}
