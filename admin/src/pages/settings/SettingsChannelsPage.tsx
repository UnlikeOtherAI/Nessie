import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { ChannelSettingsDialog } from '../../components/shared/ChannelSettingsDialog'
import { useAllChannels, useArchiveChannel } from '../../facades/channels/hooks'
import type { ChannelRecord } from '../../lib/api-client'
import type { AdminShellOutletContext } from '../../layouts/AdminShellLayout'
import { sectionTitleClass, SettingsPanel } from './settings-shared'

export const SettingsChannelsPage = () => {
  const { onCreateChannel } = useOutletContext<AdminShellOutletContext>()
  const { data: channels = [] } = useAllChannels()
  const archiveChannel = useArchiveChannel()
  const [editing, setEditing] = useState<ChannelRecord | null>(null)

  const activeChannels = channels.filter((channel) => !channel.archivedAt)
  const archivedChannels = channels.filter((channel) => channel.archivedAt)

  const renderRow = (channel: ChannelRecord, archived: boolean) => (
    <div
      key={channel.id}
      className={[
        'admin-card flex items-center justify-between gap-3 p-3 text-left',
        'cursor-pointer hover:bg-[color:var(--main-hover)]',
      ].join(' ')}
      onClick={() => setEditing(channel)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setEditing(channel)
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="min-w-0">
        <div className="truncate font-semibold text-[color:var(--tx)]">#{channel.label}</div>
        <div className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          {channel.visibility}
        </div>
      </div>
      {archived ? (
        <button
          className="admin-button admin-button-secondary shrink-0"
          disabled={archiveChannel.isPending}
          onClick={(event) => {
            event.stopPropagation()
            void archiveChannel.mutateAsync({ archived: false, channelId: channel.id })
          }}
          type="button"
        >
          Unarchive
        </button>
      ) : null}
    </div>
  )

  return (
    <SettingsPanel
      eyebrow="Workspace"
      title="Channels"
      actions={
        <button
          className="admin-button admin-button-primary"
          onClick={() => onCreateChannel()}
          type="button"
        >
          Create channel
        </button>
      }
    >
      <section className="admin-card p-4">
        <div className={sectionTitleClass}>All channels</div>
        <div className="mt-4 grid gap-2">
          {activeChannels.map((channel) => renderRow(channel, false))}
        </div>
      </section>

      {archivedChannels.length > 0 ? (
        <section className="admin-card mt-4 p-4">
          <div className={sectionTitleClass}>Archived</div>
          <div className="mt-4 grid gap-2">
            {archivedChannels.map((channel) => renderRow(channel, true))}
          </div>
        </section>
      ) : null}

      {editing ? (
        <ChannelSettingsDialog channel={editing} onClose={() => setEditing(null)} open />
      ) : null}
    </SettingsPanel>
  )
}
