import { useRef, useState } from 'react'
import { UserAvatar } from '../../../components/primitives/UserAvatar'
import { CircleImageCropper } from '../../../components/shared/CircleImageCropper'
import { useUpdateMyAvatar } from '../../../facades/auth/hooks'
import { uploadAttachment } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { sectionTitleClass } from '../settings-shared'

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
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!me) return null

  const hasCustom = Boolean(me.user.avatarAttachmentId)
  const hasProvider = Boolean(me.user.avatarUrl)
  const busy = uploading || updateAvatar.isPending

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    setSelectedFile(file)
  }

  const handleSave = async (blob: Blob) => {
    setUploading(true)
    setError(null)
    try {
      const file = new File([blob], 'avatar.png', { type: 'image/png' })
      const attachment = await uploadAttachment(file, token)
      await updateAvatar.mutateAsync(attachment.id)
      setSelectedFile(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save photo')
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
    <section className="admin-card p-4">
      <div className={sectionTitleClass}>Profile photo</div>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">{sourceHint(hasCustom, hasProvider)}</div>

      <div className="mt-4 flex items-center gap-5">
        <UserAvatar
          avatarAttachmentId={me.user.avatarAttachmentId}
          avatarUrl={me.user.avatarUrl}
          className="border border-[color:var(--sep)]"
          displayName={me.user.displayName}
          gravatarUrl={me.user.gravatarUrl}
          size={96}
          token={token}
        />

        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              className="admin-button admin-button-primary"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              {hasCustom ? 'Replace photo' : 'Upload photo'}
            </button>
            {hasCustom && (
              <button
                className="admin-button admin-button-secondary"
                disabled={busy}
                onClick={handleRemove}
                type="button"
              >
                Remove
              </button>
            )}
          </div>
          <div className="text-xs text-[color:var(--tx3)]">PNG or JPG. Square images work best.</div>
          <input
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
            ref={inputRef}
            type="file"
          />
        </div>
      </div>

      {error && <div className="mt-3 text-sm text-[color:var(--danger-text)]">{error}</div>}

      {selectedFile && (
        <CircleImageCropper
          busy={busy}
          description="Drag to reposition, scroll or use the slider to zoom. The circle becomes your photo."
          file={selectedFile}
          onCancel={() => setSelectedFile(null)}
          onSave={handleSave}
          saveLabel="Save photo"
          title="Edit profile photo"
        />
      )}
    </section>
  )
}
