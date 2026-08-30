import { useEffect, useRef, useState, type FormEvent } from 'react'

import { useUpdateProject } from '../../facades/projects/hooks'
import { uploadAttachment } from '../../lib/uploads'
import type { ProjectRecord } from '../../lib/api-client'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { ProjectAvatar } from '../primitives/ProjectAvatar'
import { AvatarUploadPanel } from './AvatarUploadPanel'
import { EmojiPickerPanel } from './EmojiPickerPanel'
import { useOverlayDismiss } from './useOverlayDismiss'

type EditProjectDialogProps = {
  onClose: () => void
  open: boolean
  project: ProjectRecord
}

export const EditProjectDialog = ({ onClose, open, project }: EditProjectDialogProps) => {
  const { token } = useAuthSession()
  const nameInputRef = useRef<HTMLInputElement>(null)
  const updateProject = useUpdateProject()
  const [name, setName] = useState(project.name)
  const [avatarEmoji, setAvatarEmoji] = useState<string | null>(project.avatarEmoji)
  const [avatarAttachmentId, setAvatarAttachmentId] = useState<string | null>(project.avatarAttachmentId)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(project.name)
    setAvatarEmoji(project.avatarEmoji)
    setAvatarAttachmentId(project.avatarAttachmentId)
    setEmojiPickerOpen(false)
    setError(null)
    nameInputRef.current?.focus()
  }, [open, project])

  const handleClose = () => {
    setEmojiPickerOpen(false)
    onClose()
  }

  const overlayDismiss = useOverlayDismiss(handleClose)
  const busy = uploading || updateProject.isPending
  const trimmedName = name.trim()
  const changed = trimmedName !== project.name
    || avatarEmoji !== project.avatarEmoji
    || avatarAttachmentId !== project.avatarAttachmentId

  const handlePhotoSave = async (blob: Blob) => {
    setError(null)
    setUploading(true)
    try {
      const attachment = await uploadAttachment(
        new File([blob], 'project-avatar.png', { type: 'image/png' }),
        token,
      )
      setAvatarAttachmentId(attachment.id)
      setAvatarEmoji(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to upload project photo')
      throw saveError
    } finally {
      setUploading(false)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!trimmedName || !changed) return

    setError(null)
    try {
      await updateProject.mutateAsync({
        avatarAttachmentId,
        avatarEmoji,
        name: trimmedName,
        projectId: project.id,
      })
      handleClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update project')
    }
  }

  if (!open) return null

  return (
    <div
      {...overlayDismiss}
      style={{
        alignItems: 'center',
        backdropFilter: 'blur(4px)',
        background: 'var(--scrim-strong)',
        display: 'flex',
        inset: 0,
        justifyContent: 'center',
        position: 'fixed',
        zIndex: 9999,
      }}
    >
      <div className="create-channel-panel w-full max-w-xl">
        <div className="create-channel-header">
          <h2 className="text-lg font-bold text-[color:var(--tx)]">Edit project</h2>
          <button
            aria-label="Close edit project"
            className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]"
            onClick={handleClose}
            type="button"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <form className="grid gap-5" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]" htmlFor="edit-project-name">
              Name
            </label>
            <input
              ref={nameInputRef}
              autoComplete="off"
              className="admin-input"
              id="edit-project-name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>

          <div className="grid gap-3 rounded-xl border border-[color:var(--sep)] bg-[color:var(--main)] p-4">
            <div className="flex items-center gap-3">
              <ProjectAvatar
                avatarAttachmentId={avatarAttachmentId}
                avatarEmoji={avatarEmoji}
                className="border border-[color:var(--sep)]"
                name={trimmedName || project.name}
                size={64}
                token={token}
              />
              <div>
                <div className="text-sm font-semibold text-[color:var(--tx)]">Project picture</div>
                <div className="text-sm text-[color:var(--tx2)]">Choose an emoji or a cropped photo.</div>
              </div>
            </div>

            <div className="relative flex flex-wrap gap-2">
              <button
                className="admin-button admin-button-secondary"
                disabled={busy}
                onClick={() => setEmojiPickerOpen((value) => !value)}
                type="button"
              >
                {avatarEmoji ? 'Change emoji' : 'Choose emoji'}
              </button>
              {avatarEmoji ? (
                <button
                  className="admin-button admin-button-secondary"
                  disabled={busy}
                  onClick={() => setAvatarEmoji(null)}
                  type="button"
                >
                  Remove emoji
                </button>
              ) : null}
              {emojiPickerOpen ? (
                <div className="absolute left-0 top-full z-20 mt-2 w-[min(360px,calc(100vw-4rem))] shadow-xl">
                  <EmojiPickerPanel
                    onSelect={(emoji) => {
                      setAvatarEmoji(emoji)
                      setAvatarAttachmentId(null)
                      setEmojiPickerOpen(false)
                    }}
                  />
                </div>
              ) : null}
            </div>

            <AvatarUploadPanel
              busy={busy}
              cropperDescription="Drag to reposition, scroll or use the slider to zoom. The rounded square becomes the project photo."
              cropperTitle="Edit project photo"
              error={error}
              hasCustom={Boolean(avatarAttachmentId)}
              helperText="PNG or JPG. Square images work best."
              hint="Uploading a photo replaces the selected emoji."
              onRemove={() => setAvatarAttachmentId(null)}
              onSave={handlePhotoSave}
              preview={<span className="hidden" aria-hidden="true" />}
              replaceLabel="Replace photo"
              saveLabel="Use photo"
              title="Photo"
              uploadLabel="Upload photo"
            />
          </div>

          {error ? <div className="text-sm text-[color:var(--danger-text)]">{error}</div> : null}

          <div className="flex justify-end gap-2 pt-1">
            <button className="admin-button admin-button-secondary" onClick={handleClose} type="button">
              Cancel
            </button>
            <button className="admin-button admin-button-primary" disabled={!trimmedName || !changed || busy} type="submit">
              Save changes
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
