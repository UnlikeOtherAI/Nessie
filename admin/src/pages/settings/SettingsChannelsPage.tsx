import { useNavigate, useOutletContext } from 'react-router-dom'
import { useChannels } from '../../facades/channels/hooks'
import type { AdminShellOutletContext } from '../../layouts/AdminShellLayout'
import { sectionTitleClass, SettingsPanel } from './settings-shared'

export const SettingsChannelsPage = () => {
  const navigate = useNavigate()
  const { onCreateChannel } = useOutletContext<AdminShellOutletContext>()
  const { data: channels = [] } = useChannels()

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
          {channels.map((channel) => (
            <button
              key={channel.id}
              className={[
                'admin-card flex items-center justify-between p-3 text-left',
                'hover:bg-[color:var(--main-hover)]',
              ].join(' ')}
              onClick={() => void navigate(`/channels/${channel.id}`)}
              type="button"
            >
              <div>
                <div className="font-semibold text-[color:var(--tx)]">#{channel.label}</div>
                <div className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  {channel.visibility}
                </div>
              </div>
              <div className="text-xs text-[color:var(--tx3)]">{channel.id}</div>
            </button>
          ))}
        </div>
      </section>
    </SettingsPanel>
  )
}
