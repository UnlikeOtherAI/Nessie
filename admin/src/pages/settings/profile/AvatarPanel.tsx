import { useState } from 'react'
import { UserAvatar } from '../../../components/primitives/UserAvatar'
import { AvatarUploadPanel } from '../../../components/shared/AvatarUploadPanel'
import {
  useMyAvatarRevision,
  useRemoveMyUoaAvatar,
  useUpdateMyAvatar,
  useUploadMyUoaAvatar,
} from '../../../facades/auth/hooks'
import { uploadAttachment } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

/**
 * The signed-in person's profile photo.
 *
 * Where it is stored depends on who owns the profile. A UOA session's photo
 * belongs to UnlikeOtherAI: the crop is relayed straight to
 * `PUT /api/auth/me/avatar/uoa` and appears everywhere UOA is used, and the
 * local-attachment route refuses those sessions outright. Deployments with no
 * UOA keep the local upload unchanged.
 */

// Describe which image the person currently sees, so the resolution order the
// avatar actually uses is visible rather than guessed at.
const localSourceHint = (hasCustom: boolean, hasProvider: boolean): string => {
  if (hasCustom) return 'Using your uploaded photo. Remove it to fall back to your account picture.'
  if (hasProvider) return 'Using your sign-in provider photo. Upload one to override it.'
  return 'Using your initials. Upload a photo to use your own.'
}

const UOA_HINT =
  'Your photo is held by UnlikeOtherAI, which manages your profile. '
  + 'Changing it here changes it everywhere you use that account.'

export const AvatarPanel = () => {
  const { me, token } = useAuthSession()
  const revision = useMyAvatarRevision()
  const updateAvatar = useUpdateMyAvatar()
  const uploadUoaAvatar = useUploadMyUoaAvatar()
  const removeUoaAvatar = useRemoveMyUoaAvatar()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!me) return null

  const managedByUoa = me.auth.providerType === 'uoa'
  const hasCustom = Boolean(me.user.avatarAttachmentId)
  const hasProvider = Boolean(me.user.avatarUrl)
  const busy =
    uploading
    || updateAvatar.isPending
    || uploadUoaAvatar.isPending
    || removeUoaAvatar.isPending

  const handleSave = async (blob: Blob) => {
    setUploading(true)
    setError(null)
    try {
      const file = new File([blob], 'avatar.png', { type: 'image/png' })
      if (managedByUoa) {
        await uploadUoaAvatar.mutateAsync(file)
      } else {
        const attachment = await uploadAttachment(file, token)
        await updateAvatar.mutateAsync(attachment.id)
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save photo')
      throw saveError
    } finally {
      setUploading(false)
    }
  }

  const handleRemove = () => {
    setError(null)
    const onError = (removeError: unknown) =>
      setError(removeError instanceof Error ? removeError.message : 'Failed to remove photo')
    if (managedByUoa) {
      removeUoaAvatar.mutate(undefined, { onError })
      return
    }
    updateAvatar.mutate(null, { onError })
  }

  return (
    <AvatarUploadPanel
      busy={busy}
      cropperDescription="Drag to reposition, scroll or use the slider to zoom. The rounded square becomes your photo."
      cropperTitle="Edit profile photo"
      error={error}
      // UOA always resolves an image for a person it knows (uploaded, proxied
      // or generated) and does not tell the browser which, so the remove
      // control stays available: it clears whatever was uploaded there.
      hasCustom={managedByUoa || hasCustom}
      hint={managedByUoa ? UOA_HINT : localSourceHint(hasCustom, hasProvider)}
      preview={
        <UserAvatar
          avatarAttachmentId={me.user.avatarAttachmentId}
          avatarUrl={me.user.avatarUrl}
          className="border border-[color:var(--sep)]"
          displayName={me.user.displayName}
          revision={revision}
          size={96}
          token={token}
          userId={me.user.id}
        />
      }
      saveLabel="Save photo"
      title="Profile photo"
      onRemove={handleRemove}
      onSave={handleSave}
    />
  )
}
