import { toChannelNameInput, toChannelSlug } from '@nessie/schemas'
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChannelRecord } from '../../lib/api-client'
import {
  useArchiveChannel,
  useUpdateChannel,
} from '../../facades/channels/hooks'
import { ConfirmDialog } from './ConfirmDialog'
import { Dialog } from './Dialog'
import { fieldErrorAria, fieldErrorProps } from './FormFieldError'

type ChannelSettingsDialogProps = {
  channel: ChannelRecord
  onClose: () => void
  open: boolean
}

export const ChannelSettingsDialog = (
  { channel, onClose, open }: ChannelSettingsDialogProps,
) => {
  const navigate = useNavigate()
  const updateChannel = useUpdateChannel()
  const archiveChannel = useArchiveChannel()

  const [label, setLabel] = useState(channel.label)
  const [topic, setTopic] = useState(channel.topic ?? '')
  const [description, setDescription] = useState(channel.description ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const isArchived = Boolean(channel.archivedAt)

  useEffect(() => {
    if (open) {
      setLabel(channel.label)
      setTopic(channel.topic ?? '')
      setDescription(channel.description ?? '')
      setConfirmDelete(false)
      setConfirmArchive(false)
      setFormError(null)
    }
  }, [open, channel])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextLabel = toChannelSlug(label)
    if (!nextLabel) return

    try {
      await updateChannel.mutateAsync({
        channelId: channel.id,
        label: nextLabel,
        topic: topic.trim() ? topic.trim() : null,
        description: description.trim() ? description.trim() : null,
      })
      onClose()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save channel.')
    }
  }

  const handleArchiveToggle = async () => {
    await archiveChannel.mutateAsync({
      archived: !isArchived,
      channelId: channel.id,
    })
    setConfirmArchive(false)
    onClose()
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await archiveChannel.mutateAsync({ archived: true, channelId: channel.id })
    onClose()
    void navigate('/channels')
  }

  return (
    <>
      <Dialog description={`#${channel.label}`} onClose={onClose} open={open} title="Channel settings">
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <label
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
              htmlFor="channel-settings-name"
            >
              Name
            </label>
            <input
              {...fieldErrorAria('channel-settings-name', formError)}
              autoComplete="off"
              className="admin-input"
              id="channel-settings-name"
              onChange={(e) => {
                setLabel(toChannelNameInput(e.target.value))
                setFormError(null)
              }}
              onBlur={() => setLabel(toChannelSlug(label))}
              value={label}
            />
            <div className="text-xs text-[color:var(--tx3)]">
              Lowercase letters, numbers and hyphens. Spaces become hyphens.
            </div>
            {/*
              Same shape as CreateChannelDialog: the red line is unchanged, and
              only the id + role="alert" pairing it to the input above is new.
              Written in the save catch, cleared on the next keystroke.
            */}
            {formError ? (
              <div
                className="text-xs text-[color:var(--danger-text)]"
                {...fieldErrorProps('channel-settings-name')}
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
              htmlFor="channel-settings-topic"
            >
              Topic
            </label>
            <input
              autoComplete="off"
              className="admin-input"
              id="channel-settings-topic"
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What is this channel about?"
              value={topic}
            />
          </div>

          <div className="grid gap-1.5">
            <label
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
              htmlFor="channel-settings-description"
            >
              Description
            </label>
            <textarea
              className="admin-input"
              id="channel-settings-description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Longer description (optional)"
              rows={3}
              value={description}
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              <button
                className="admin-button admin-button-secondary"
                disabled={archiveChannel.isPending}
                onClick={() => {
                  if (isArchived) {
                    void handleArchiveToggle()
                  } else {
                    setConfirmArchive(true)
                  }
                }}
                type="button"
              >
                {isArchived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                className="admin-button admin-button-secondary admin-button-danger"
                disabled={archiveChannel.isPending}
                onClick={handleDelete}
                type="button"
              >
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </button>
            </div>
            <div className="flex gap-2">
              <button
                className="admin-button admin-button-secondary"
                onClick={onClose}
                type="button"
              >
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary"
                disabled={!toChannelSlug(label) || updateChannel.isPending}
                type="submit"
              >
                Save
              </button>
            </div>
          </div>
        </form>
      </Dialog>

      {/* The sanctioned nesting (docs/navigation/overview.md §7): a confirm over the
          already-open settings dialog above, in the blocking layer. */}
      <ConfirmDialog
        blocking
        body={`Are you sure you want to archive #${channel.label}? It will be hidden from the channel list. You can unarchive it later.`}
        confirmLabel="Archive"
        onCancel={() => setConfirmArchive(false)}
        onConfirm={() => void handleArchiveToggle()}
        open={confirmArchive}
        pending={archiveChannel.isPending}
        title="Archive channel?"
      />
    </>
  )
}
