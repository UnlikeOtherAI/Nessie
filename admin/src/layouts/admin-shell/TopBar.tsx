import { useEffect, useReducer, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useChannels } from '../../facades/channels/hooks'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import { isDesktopApp } from '../../lib/desktop'
import { useAuthedObjectUrl } from '../../lib/uploads'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { TopBarSearch } from './TopBarSearch'
import { recordRecentChannel, useRecentChannels } from './useRecentChannels'

const iconProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  viewBox: '0 0 24 24',
  height: 18,
  width: 18,
} as const

const ChevronLeft = () => (
  <svg {...iconProps}>
    <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ChevronRight = () => (
  <svg {...iconProps}>
    <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const Clock = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const Help = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path
      d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M12 17h.01" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// Tracks position in the SPA history so the back/forward buttons can disable at
// the ends. New navigations (PUSH) advance the cursor and clear the forward
// stack; our own buttons move the cursor in step with React Router's history.
const useHistoryNav = () => {
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

// Clock button → quick-jump menu of recently opened channels.
const RecentMenu = () => {
  const navigate = useNavigate()
  const recents = useRecentChannels()
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
        className="admin-topbar-btn"
        onClick={() => setOpen((value) => !value)}
        title="Recent channels"
        type="button"
      >
        <Clock />
      </button>
      {open ? (
        <div className="admin-topbar-menu">
          {recents.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[color:var(--tx3)]">No recent channels</p>
          ) : (
            recents.map((channel) => (
              <button
                className="admin-topbar-menu-item"
                key={channel.id}
                onClick={() => {
                  navigate(`/channels/${channel.id}`)
                  setOpen(false)
                }}
                type="button"
              >
                <span className="text-[color:var(--tx3)]">#</span>
                <span className="truncate">{channel.label}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

// Workspace badge: the org's round logo (or its initial), linking to settings.
const WorkspaceBadge = () => {
  const { token } = useAuthSession()
  const { data: organization } = useCurrentOrganization()
  const logoUrl = useAuthedObjectUrl(organization?.logoAttachmentId ?? null, token)

  return (
    <Link
      aria-label="Workspace settings"
      className="admin-topbar-workspace"
      title={organization?.name ?? 'Workspace'}
      to="/settings"
    >
      {logoUrl ? (
        <img alt="" className="h-full w-full object-cover" src={logoUrl} />
      ) : (
        <span>{(organization?.name ?? 'N').charAt(0).toUpperCase()}</span>
      )}
    </Link>
  )
}

// Slack-style global top bar. Rendered full-width above the rail and content. On
// the desktop (Tauri) app it doubles as the window title bar, with dedicated
// drag regions around the interactive search field and buttons.
export const TopBar = () => {
  const desktop = isDesktopApp()
  const location = useLocation()
  const { data: channels = [] } = useChannels()
  const { goBack, goForward, canBack, canForward } = useHistoryNav()

  // Remember channel visits so the recent menu has something to show.
  useEffect(() => {
    const match = location.pathname.match(/^\/channels\/([^/]+)/)
    if (!match) return
    const channel = channels.find((entry) => entry.id === match[1])
    if (channel) recordRecentChannel({ id: channel.id, label: channel.label })
  }, [location.pathname, channels])

  return (
    <header
      className={['admin-topbar', desktop ? 'admin-topbar--desktop' : ''].filter(Boolean).join(' ')}
    >
      {desktop ? (
        <div
          aria-hidden="true"
          className="admin-topbar-drag-zone admin-topbar-drag-zone--traffic"
          data-tauri-drag-region
        />
      ) : null}

      <div className="hidden items-center gap-1 md:flex">
        <button
          aria-label="Back"
          className="admin-topbar-btn"
          disabled={!canBack}
          onClick={goBack}
          title="Back"
          type="button"
        >
          <ChevronLeft />
        </button>
        <button
          aria-label="Forward"
          className="admin-topbar-btn"
          disabled={!canForward}
          onClick={goForward}
          title="Forward"
          type="button"
        >
          <ChevronRight />
        </button>
        <RecentMenu />
      </div>

      {desktop ? (
        <div aria-hidden="true" className="admin-topbar-drag-zone" data-tauri-drag-region />
      ) : null}

      <TopBarSearch />

      {desktop ? (
        <div aria-hidden="true" className="admin-topbar-drag-zone" data-tauri-drag-region />
      ) : null}

      <div className="flex items-center gap-1">
        <WorkspaceBadge />
        <Link aria-label="Help & feedback" className="admin-topbar-btn" title="Help & feedback" to="/feedback">
          <Help />
        </Link>
      </div>
    </header>
  )
}
