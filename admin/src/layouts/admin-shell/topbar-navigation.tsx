import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useChannels } from '../../facades/channels/hooks'
import { recordRecentChannel, useRecentChannels } from './useRecentChannels'
import { useTransientMenu } from './TransientMenuContext'

export const useRecordRecentChannelVisits = () => {
  const location = useLocation()
  const { data: channels = [] } = useChannels()

  useEffect(() => {
    const match = location.pathname.match(/^\/channels\/([^/]+)/)
    if (!match) return
    const channel = channels.find((entry) => entry.id === match[1])
    if (channel) recordRecentChannel({ id: channel.id, label: channel.label })
  }, [location.pathname, channels])
}

type RecentChannelsControlProps = {
  buttonClassName?: string
}

// Reuse the same recents menu in each presentation of the global phone/tablet
// header so its history and navigation always agree.
export const RecentChannelsControl = ({
  buttonClassName = 'admin-topbar-btn',
}: RecentChannelsControlProps): React.JSX.Element => {
  const { close, isOpen: open, toggle } = useTransientMenu()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [close, open])

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label="Recent channels"
        className={buttonClassName}
        onClick={toggle}
        title="Recent channels"
        type="button"
      >
        <svg fill="none" height="22" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="22">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? <RecentChannelsMenu onSelect={close} /> : null}
    </div>
  )
}

type RecentChannelsMenuProps = {
  className?: string
  empty?: ReactNode
  onSelect?: () => void
  style?: CSSProperties
}

export const RecentChannelsMenu = ({
  className = 'admin-topbar-menu',
  empty,
  onSelect,
  style,
}: RecentChannelsMenuProps) => {
  const navigate = useNavigate()
  const recents = useRecentChannels()

  return (
    <div className={className} style={style}>
      {recents.length === 0 ? (
        empty ?? <p className="px-3 py-2 text-xs text-[color:var(--tx3)]">No recent channels</p>
      ) : (
        recents.map((channel) => (
          <button
            className="admin-topbar-menu-item"
            key={channel.id}
            onClick={() => {
              navigate(`/channels/${channel.id}`)
              onSelect?.()
            }}
            type="button"
          >
            <span className="text-[color:var(--tx3)]">#</span>
            <span className="min-w-0 flex-1 truncate">{channel.label}</span>
          </button>
        ))
      )}
    </div>
  )
}
