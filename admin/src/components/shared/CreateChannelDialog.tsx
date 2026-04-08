import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCreateChannel } from '../../facades/channels/hooks'

const toSlug = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

type CreateChannelDialogProps = {
  onClose: () => void
  open: boolean
}

export const CreateChannelDialog = ({ onClose, open }: CreateChannelDialogProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const createChannel = useCreateChannel()

  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'protected' | 'public'>('public')

  const slug = toSlug(name)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open && !dialog.open) {
      dialog.showModal()
      nameInputRef.current?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const handleClose = () => {
      setName('')
      setVisibility('public')
      onClose()
    }

    dialog.addEventListener('close', handleClose)
    return () => dialog.removeEventListener('close', handleClose)
  }, [onClose])

  const handleBackdropClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) {
      dialogRef.current?.close()
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim()) return

    const created = await createChannel.mutateAsync({
      label: name.trim(),
      visibility,
    })
    dialogRef.current?.close()
    void navigate(`/channels/${created.id}`)
  }

  return (
    <dialog
      ref={dialogRef}
      className="create-channel-dialog"
      onClick={handleBackdropClick}
    >
      <div className="create-channel-dialog-content">
        <div className="create-channel-dialog-header">
          <h2 className="text-lg font-bold text-white">Create a channel</h2>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center rounded',
              'text-[color:var(--tx3)] hover:bg-white/10 hover:text-white',
            ].join(' ')}
            onClick={() => dialogRef.current?.close()}
            type="button"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <label
              className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]"
              htmlFor="channel-name"
            >
              Name
            </label>
            <input
              ref={nameInputRef}
              autoComplete="off"
              className="admin-input"
              id="channel-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. design-reviews"
              value={name}
            />
          </div>

          <div className="grid gap-1.5">
            <label
              className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]"
              htmlFor="channel-slug"
            >
              Slug
            </label>
            <input
              className="admin-input opacity-60"
              disabled
              id="channel-slug"
              value={slug}
            />
          </div>

          <div className="grid gap-1.5">
            <label
              className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]"
              htmlFor="channel-visibility"
            >
              Visibility
            </label>
            <select
              className="admin-input"
              id="channel-visibility"
              onChange={(event) => setVisibility(event.target.value as typeof visibility)}
              value={visibility}
            >
              <option value="public">Public</option>
              <option value="protected">Protected</option>
              <option value="private">Private</option>
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              className="admin-button admin-button-secondary"
              onClick={() => dialogRef.current?.close()}
              type="button"
            >
              Cancel
            </button>
            <button
              className="admin-button admin-button-primary"
              disabled={!name.trim()}
              type="submit"
            >
              Create channel
            </button>
          </div>
        </form>
      </div>
    </dialog>
  )
}
