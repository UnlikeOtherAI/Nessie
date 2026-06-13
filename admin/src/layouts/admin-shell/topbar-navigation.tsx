import { useEffect, useReducer, useRef, type CSSProperties, type ReactNode } from 'react'
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
