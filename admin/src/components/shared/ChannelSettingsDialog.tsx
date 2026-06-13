import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChannelRecord } from '../../lib/api-client'
import {
  useArchiveChannel,
  useUpdateChannel,
} from '../../facades/channels/hooks'

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

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!label.trim()) return

    try {
      await updateChannel.mutateAsync({
        channelId: channel.id,
        label: label.trim(),
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

  if (!open) return null

  return (
    <div
      onClick={handleOverlayClick}
      role="presentation"
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
            <h2 className="text-lg font-bold text-[color:var(--tx)]">Channel settings</h2>
            <div className="text-xs text-[color:var(--tx3)]">#{channel.label}</div>
          </div>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
            ].join(' ')}
            onClick={onClose}
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
              htmlFor="channel-settings-name"
            >
              Name
            </label>
            <input
              autoComplete="off"
              className="admin-input"
              id="channel-settings-name"
              onChange={(e) => {
                setLabel(e.target.value)
                setFormError(null)
              }}
              value={label}
            />
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
                className="admin-button admin-button-secondary text-[color:var(--danger-text)]"
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
                disabled={!label.trim() || updateChannel.isPending}
                type="submit"
              >
                Save
              </button>
            </div>
          </div>
        </form>
      </div>

      {confirmArchive ? (
        <div
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmArchive(false)
          }}
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--scrim-strong)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div className="create-channel-panel" style={{ maxWidth: '24rem' }}>
            <h2 className="text-lg font-bold text-[color:var(--tx)]">Archive channel?</h2>
            <p className="mt-2 text-sm text-[color:var(--tx2)]">
              Are you sure you want to archive #{channel.label}? It will be hidden from the
              channel list. You can unarchive it later.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="admin-button admin-button-secondary"
                onClick={() => setConfirmArchive(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary"
                disabled={archiveChannel.isPending}
                onClick={handleArchiveToggle}
                type="button"
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
