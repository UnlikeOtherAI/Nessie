import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UserAvatar } from '../../shared/UserAvatar'
import { AvatarUploadPanel } from '../../shared/AvatarUploadPanel'
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
export const AvatarPanel = () => {
  const { t } = useTranslation('settings')
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
      setError(saveError instanceof Error ? saveError.message : t('avatar.saveFailed'))
      throw saveError
    } finally {
      setUploading(false)
    }
  }

  const handleRemove = () => {
    setError(null)
    const onError = (removeError: unknown) =>
      setError(removeError instanceof Error ? removeError.message : t('avatar.removeFailed'))
    if (managedByUoa) {
      removeUoaAvatar.mutate(undefined, { onError })
      return
    }
    updateAvatar.mutate(null, { onError })
  }

  return (
    <AvatarUploadPanel
      busy={busy}
      confirmationBody={t('avatar.removeConfirmation', { title: t('avatar.title').toLowerCase() })}
      confirmationTitle={t('avatar.removeConfirmationTitle')}
      cropperDescription={t('avatar.cropperDescription')}
      cropperTitle={t('avatar.editPhoto')}
      error={error}
      // UOA always resolves an image for a person it knows (uploaded, proxied
      // or generated) and does not tell the browser which, so the remove
      // control stays available: it clears whatever was uploaded there.
      hasCustom={managedByUoa || hasCustom}
      hint={managedByUoa
        ? t('avatar.uoaHint')
        : hasCustom
          ? t('avatar.customHint')
          : hasProvider
            ? t('avatar.providerHint')
            : t('avatar.initialsHint')}
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
      saveLabel={t('avatar.savePhoto')}
      title={t('avatar.title')}
      helperText={t('avatar.fileHint')}
      removeLabel={t('avatar.remove')}
      replaceLabel={t('avatar.replacePhoto')}
      uploadLabel={t('avatar.uploadPhoto')}
      onRemove={handleRemove}
      onSave={handleSave}
    />
  )
}
