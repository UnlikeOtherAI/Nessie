import { useRef, useState } from 'react'
import { Popover } from '../../../components/overlays/Popover'
import { ProjectAvatar } from '../../../components/primitives/ProjectAvatar'
import { AvatarUploadPanel } from '../../../components/shared/AvatarUploadPanel'
import { EmojiPickerPanel } from '../../../components/shared/EmojiPickerPanel'
import { uploadAttachment } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

export type ProjectPicture = {
  avatarAttachmentId: string | null
  avatarEmoji: string | null
}

type ProjectPictureFieldProps = {
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onChange: (picture: ProjectPicture) => void
  picture: ProjectPicture
}

/**
 * A project's picture: an emoji or a cropped photo, never both — the update
 * route keeps them mutually exclusive, so choosing one clears the other here
 * too and the preview never shows a combination the server would not store.
 *
 * The emoji grid is the shared `Popover` (outside press, Escape and its layer
 * are the primitive's), not a panel hung off the button with its own z-index.
 */
export const ProjectPictureField = ({
  disabled,
  onBusyChange,
  onChange,
  picture,
}: ProjectPictureFieldProps) => {
  const { token } = useAuthSession()
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = disabled || uploading

  const savePhoto = async (blob: Blob) => {
    setError(null)
    setUploading(true)
    onBusyChange(true)
    try {
      const attachment = await uploadAttachment(
        new File([blob], 'project-avatar.png', { type: 'image/png' }),
        token,
      )
      onChange({ avatarAttachmentId: attachment.id, avatarEmoji: null })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The photo could not be uploaded.')
      throw cause
    } finally {
      setUploading(false)
      onBusyChange(false)
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ProjectAvatar
          avatarAttachmentId={picture.avatarAttachmentId}
          avatarEmoji={picture.avatarEmoji}
          className="border border-[color:var(--sep)]"
          size={64}
          token={token}
        />
        <div className="flex flex-wrap gap-2">
          <button
            aria-expanded={emojiOpen}
            aria-haspopup="dialog"
            className="admin-button admin-button-secondary"
            disabled={busy}
            onClick={() => setEmojiOpen((open) => !open)}
            ref={emojiButtonRef}
            type="button"
          >
            {picture.avatarEmoji ? 'Change emoji' : 'Choose emoji'}
          </button>
          {picture.avatarEmoji ? (
            <button
              className="admin-button admin-button-secondary"
              disabled={busy}
              onClick={() => onChange({ ...picture, avatarEmoji: null })}
              type="button"
            >
              Remove emoji
            </button>
          ) : null}
        </div>
      </div>
      <Popover
        anchorRef={emojiButtonRef}
        className="w-[min(22rem,calc(100vw-2rem))] overflow-y-auto shadow-lg"
        label="Choose a project emoji"
        onClose={() => setEmojiOpen(false)}
        open={emojiOpen}
        placement="bottom-start"
        role="dialog"
      >
        <EmojiPickerPanel
          onSelect={(emoji) => {
            onChange({ avatarAttachmentId: null, avatarEmoji: emoji })
            setEmojiOpen(false)
          }}
        />
      </Popover>
      <AvatarUploadPanel
        busy={busy}
        cropperDescription="Drag to reposition, scroll or use the slider to zoom. The rounded square becomes the project photo."
        cropperTitle="Edit project photo"
        error={error}
        hasCustom={Boolean(picture.avatarAttachmentId)}
        helperText="PNG or JPG. Square images work best."
        hint="Uploading a photo replaces the emoji."
        onRemove={() => onChange({ ...picture, avatarAttachmentId: null })}
        onSave={savePhoto}
        preview={<span aria-hidden="true" className="hidden" />}
        replaceLabel="Replace photo"
        saveLabel="Use photo"
        title="Photo"
        uploadLabel="Upload photo"
      />
    </div>
  )
}
