import { useState } from 'react'
import { UserAvatar } from '../../../components/primitives/UserAvatar'
import { AvatarUploadPanel } from '../../../components/shared/AvatarUploadPanel'
import { useUpdateMyAvatar } from '../../../facades/auth/hooks'
import { uploadAttachment } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

// Describe which image the user currently sees, so the helper text makes the
// custom > Google > Gravatar precedence visible.
const sourceHint = (hasCustom: boolean, hasProvider: boolean): string => {
  if (hasCustom) return 'Using your uploaded photo. Remove it to fall back to your account picture.'
  if (hasProvider) return 'Using your sign-in provider photo. Upload one to override it.'
  return 'Using your Gravatar (or initials). Upload a photo to use your own.'
}

export const AvatarPanel = () => {
  const { me, token } = useAuthSession()
  const updateAvatar = useUpdateMyAvatar()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!me) return null

  const hasCustom = Boolean(me.user.avatarAttachmentId)
  const hasProvider = Boolean(me.user.avatarUrl)
  const busy = uploading || updateAvatar.isPending

  const handleSave = async (blob: Blob) => {
    setUploading(true)
    setError(null)
    try {
      const file = new File([blob], 'avatar.png', { type: 'image/png' })
      const attachment = await uploadAttachment(file, token)
      await updateAvatar.mutateAsync(attachment.id)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save photo')
      throw saveError
    } finally {
      setUploading(false)
    }
  }

  const handleRemove = () => {
    setError(null)
    updateAvatar.mutate(null, {
      onError: (removeError) =>
        setError(removeError instanceof Error ? removeError.message : 'Failed to remove photo'),
    })
  }

  return (
    <AvatarUploadPanel
      busy={busy}
      cropperDescription="Drag to reposition, scroll or use the slider to zoom. The circle becomes your photo."
      cropperTitle="Edit profile photo"
      error={error}
      hasCustom={hasCustom}
      hint={sourceHint(hasCustom, hasProvider)}
      preview={
        <UserAvatar
          avatarAttachmentId={me.user.avatarAttachmentId}
          avatarUrl={me.user.avatarUrl}
          className="border border-[color:var(--sep)]"
          displayName={me.user.displayName}
          gravatarUrl={me.user.gravatarUrl}
          size={96}
          token={token}
        />
      }
      saveLabel="Save photo"
      title="Profile photo"
      onRemove={handleRemove}
      onSave={handleSave}
    />
  )
}
