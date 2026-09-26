import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useArchiveChannel, useDeleteChannel } from '../../../../facades/channels/hooks'
import type { ChannelRecord } from '../../../../lib/api-client'
import { ConfirmDialog } from '../../../shared/ConfirmDialog'
import { FormError } from '../../../shared/FormActions'
import { Section } from '../../../shared/PageBody'

type Pending = 'archive' | 'delete' | null

/**
 * Archiving and deleting a room, the last of General. Archive hides it from
 * the channel list and can be undone; Delete is `DELETE /api/channels/:id`, a
 * soft delete nothing in the admin can undo — the settings dialog this
 * replaced labelled its archive "Delete". Unarchiving can be refused (the
 * name was taken while the room was away), and the refusal is said here.
 */
export const DetailsRoomLifecycle = ({ canManage, channel }: { canManage: boolean; channel: ChannelRecord }) => {
  const navigate = useNavigate()
  const archiveChannel = useArchiveChannel()
  const deleteChannel = useDeleteChannel()
  const [pending, setPending] = useState<Pending>(null)
  const [error, setError] = useState<string | null>(null)
  const isArchived = Boolean(channel.archivedAt)
  const busy = archiveChannel.isPending || deleteChannel.isPending

  const setArchived = async (archived: boolean) => {
    setError(null)
    try {
      await archiveChannel.mutateAsync({ archived, channelId: channel.id })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The channel could not be changed.')
    } finally {
      setPending(null)
    }
  }

  const remove = async () => {
    setError(null)
    try {
      await deleteChannel.mutateAsync(channel.id)
      // The room, its Details and every address under it are gone.
      void navigate('/channels', { replace: true })
    } catch (cause) {
      setPending(null)
      setError(cause instanceof Error ? cause.message : 'The channel could not be deleted.')
    }
  }

  return (
    <div className="border-t border-[color:var(--sep)] pt-5">
      <Section
        description="Archiving hides the channel from the list and can be undone. Deleting removes it for everyone, and nothing here can bring it back."
        title={isArchived ? 'Archived' : 'Archive or delete'}
      >
        <FormError>{error ?? undefined}</FormError>
        <div className="flex flex-wrap gap-2">
          <button
            className="admin-button admin-button-secondary"
            disabled={!canManage || busy}
            onClick={() => (isArchived ? void setArchived(false) : setPending('archive'))}
            type="button"
          >
            {isArchived ? 'Unarchive' : 'Archive'}
          </button>
          <button
            className="admin-button admin-button-secondary admin-button-danger"
            disabled={!canManage || busy}
            onClick={() => setPending('delete')}
            type="button"
          >
            Delete
          </button>
        </div>
      </Section>
      <ConfirmDialog
        body={`#${channel.label} will be hidden from the channel list. You can unarchive it later.`}
        confirmLabel="Archive"
        onCancel={() => setPending(null)}
        onConfirm={() => void setArchived(true)}
        open={pending === 'archive'}
        pending={archiveChannel.isPending}
        title="Archive channel?"
      />
      <ConfirmDialog
        body={`#${channel.label} and its conversations disappear for everyone in it. Nothing here can bring it back.`}
        confirmLabel="Delete channel"
        destructive
        onCancel={() => setPending(null)}
        onConfirm={() => void remove()}
        open={pending === 'delete'}
        pending={deleteChannel.isPending}
        title="Delete channel?"
      />
    </div>
  )
}
