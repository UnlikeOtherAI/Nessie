import { toChannelNameInput, toChannelSlug } from '@nessie/schemas'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCreateChannel } from '../../facades/channels/hooks'
import { useOverlayDismiss } from './useOverlayDismiss'

type CreateChannelDialogProps = {
  onClose: () => void
  open: boolean
  projectName?: string
  teamId?: string
}

export const CreateChannelDialog = (
  { onClose, open, projectName, teamId }: CreateChannelDialogProps,
) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const createChannel = useCreateChannel()

  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<
    'private' | 'protected' | 'public'
  >('public')
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      nameInputRef.current?.focus()
    }
  }, [open])

  const handleClose = () => {
    setName('')
    setVisibility('public')
    setFormError(null)
    onClose()
  }

  const overlayDismiss = useOverlayDismiss(handleClose)

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()
    const label = toChannelSlug(name)
    if (!label) return

    try {
      const created = await createChannel.mutateAsync({
        label,
        teamId,
        visibility,
      })
      handleClose()
      void navigate(`/channels/${created.id}`)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to create channel.')
    }
  }

  if (!open) return null

  return (
    <div
      {...overlayDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--scrim-strong)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div className="create-channel-panel">
        <div className="create-channel-header">
          <div>
            <h2 className="text-lg font-bold text-[color:var(--tx)]">Create a channel</h2>
            {projectName ? (
              <div className="text-xs text-[color:var(--tx3)]">in {projectName}</div>
            ) : null}
          </div>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
            ].join(' ')}
            onClick={handleClose}
            type="button"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                d="M6 18L18 6M6 6l12 12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <label
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
              htmlFor="channel-name"
            >
              Name
            </label>
            <input
              ref={nameInputRef}
              autoComplete="off"
              className="admin-input"
              id="channel-name"
              onChange={(e) => {
                setName(toChannelNameInput(e.target.value))
                setFormError(null)
              }}
              onBlur={() => setName(toChannelSlug(name))}
              placeholder="e.g. design-reviews"
              value={name}
            />
            <div className="text-xs text-[color:var(--tx3)]">
              Lowercase letters, numbers and hyphens. Spaces become hyphens.
            </div>
            {formError ? (
              <div className="text-xs text-[color:var(--danger-text)]">{formError}</div>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <label
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
              htmlFor="channel-visibility"
            >
              Visibility
            </label>
            <select
              className="admin-input"
              id="channel-visibility"
              onChange={(e) => setVisibility(
                e.target.value as typeof visibility,
              )}
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
              onClick={handleClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="admin-button admin-button-primary"
              disabled={!toChannelSlug(name)}
              type="submit"
            >
              Create channel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
