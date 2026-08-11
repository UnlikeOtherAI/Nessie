import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { ChannelSettingsDialog } from '../../components/shared/ChannelSettingsDialog'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
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

  // The open-settings affordance and Unarchive are sibling buttons (not nested),
  // so each is independently focusable and operable by keyboard.
  const renderRow = (channel: ChannelRecord, archived: boolean) => (
    <div
      className="admin-card flex items-center justify-between gap-3 p-3"
      key={channel.id}
    >
      <button
        className="min-w-0 flex-1 text-left"
        onClick={() => setEditing(channel)}
        type="button"
      >
        <div className="truncate font-semibold text-[color:var(--tx)]">#{channel.label}</div>
        <div className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          {channel.visibility}
        </div>
      </button>
      {archived ? (
        <button
          className="admin-button admin-button-secondary shrink-0"
          disabled={archiveChannel.isPending}
          onClick={() =>
            void archiveChannel.mutateAsync({ archived: false, channelId: channel.id })}
          type="button"
        >
          Unarchive
        </button>
      ) : null}
    </div>
  )

  return (
    <SettingsPanel
      eyebrow="Organization"
      title="Channels"
      actions={[
        {
          id: 'create-channel',
          label: 'Create channel',
          onSelect: onCreateChannel,
          primary: true,
          priority: 100,
        } satisfies PageHeaderAction,
      ]}
    >
      <section className="admin-card p-4">
        <div className={sectionTitleClass}>All channels</div>
        <div className="mt-4 grid gap-2">
          {activeChannels.length === 0 ? (
            <div className="admin-card p-3 text-sm text-[color:var(--tx3)]">
              No active channels. Use “Create channel” to add one.
            </div>
          ) : (
            activeChannels.map((channel) => renderRow(channel, false))
          )}
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
