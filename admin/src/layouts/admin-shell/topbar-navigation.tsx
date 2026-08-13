import { useEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useChannels } from '../../facades/channels/hooks'
import { recordRecentChannel, useRecentChannels } from './useRecentChannels'

// Tracks position in the SPA history so the back/forward buttons can disable at
// the ends. New navigations (PUSH) advance the cursor and clear the forward
// stack; our own buttons move the cursor in step with React Router's history.
export const useHistoryNav = () => {
  const navigate = useNavigate()
  const navType = useNavigationType()
  const location = useLocation()
  const posRef = useRef(0)
  const fwdRef = useRef(0)
  const lastKey = useRef(location.key)
  const [, force] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (location.key === lastKey.current) return
    lastKey.current = location.key
    if (navType === 'PUSH') {
      posRef.current += 1
      fwdRef.current = 0
      force()
    }
  }, [location.key, navType])

  const goBack = () => {
    if (posRef.current <= 0) return
    posRef.current -= 1
    fwdRef.current += 1
    force()
    navigate(-1)
  }

  const goForward = () => {
    if (fwdRef.current <= 0) return
    posRef.current += 1
    fwdRef.current -= 1
    force()
    navigate(1)
  }

  return { goBack, goForward, canBack: posRef.current > 0, canForward: fwdRef.current > 0 }
}

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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label="Recent channels"
        className={buttonClassName}
        onClick={() => setOpen((value) => !value)}
        title="Recent channels"
        type="button"
      >
        <svg fill="none" height="22" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="22">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? <RecentChannelsMenu onSelect={() => setOpen(false)} /> : null}
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
            <span className="truncate">{channel.label}</span>
          </button>
        ))
      )}
    </div>
  )
}
