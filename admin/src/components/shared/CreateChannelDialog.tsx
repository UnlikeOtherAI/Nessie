import { toChannelNameInput, toChannelSlug } from '@nessie/schemas'
import { useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCreateChannel } from '../../facades/channels/hooks'
import type { ChannelRecord } from '../../lib/api-client'
import { Dialog } from './Dialog'
import { fieldErrorAria, fieldErrorProps } from './FormFieldError'

type CreateChannelDialogProps = {
  onClose: () => void
  // Fires with the new channel before the navigation to it, so a sidebar
  // section that is closed can open in the same paint the row appears in.
  onCreated?: (channel: ChannelRecord) => void
  open: boolean
  projectName?: string
  scope?: 'standalone'
  teamId?: string
}

export const CreateChannelDialog = (
  { onClose, onCreated, open, projectName, scope, teamId }: CreateChannelDialogProps,
) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const createChannel = useCreateChannel()

  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<
    'private' | 'protected' | 'public'
  >('public')
  const [formError, setFormError] = useState<string | null>(null)

  const handleClose = () => {
    setName('')
    setVisibility('public')
    setFormError(null)
    onClose()
  }

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()
    const label = toChannelSlug(name)
    if (!label) return

    try {
      const created = await createChannel.mutateAsync({
        label,
        scope,
        teamId,
        visibility,
      })
      onCreated?.(created)
      handleClose()
      void navigate(`/channels/${created.id}`)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to create channel.')
    }
  }

  return (
    <Dialog
      description={projectName ? `in ${projectName}` : undefined}
      initialFocusRef={nameInputRef}
      onClose={handleClose}
      open={open}
      title="Create a channel"
    >
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
            {...fieldErrorAria('channel-name', formError)}
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
          {/*
            The bare red line is the shipped treatment and stays: only the
            announcement contract (id + role="alert", paired with the input's
            aria above) is new. `formError` is written in the submit catch and
            cleared on the next keystroke, so it announces once per rejection.
          */}
          {formError ? (
            <div
              className="text-xs text-[color:var(--danger-text)]"
              {...fieldErrorProps('channel-name')}
            >
              {formError}
            </div>
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
    </Dialog>
  )
}
