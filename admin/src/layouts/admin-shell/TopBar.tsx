import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import { isDesktopApp } from '../../lib/desktop'
import { useAuthedObjectUrl } from '../../lib/uploads'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { AlertsBell } from './AlertsBell'
import { TopBarSearch } from './TopBarSearch'
import { RecentChannelsMenu, useHistoryNav, useRecordRecentChannelVisits } from './topbar-navigation'

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

// Clock button → quick-jump menu of recently opened channels.
const RecentMenu = () => {
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
        <RecentChannelsMenu onSelect={() => setOpen(false)} />
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

type TopBarProps = {
  hideSearch?: boolean
}

// Slack-style global top bar. Rendered full-width above the rail and content. On
// the desktop (Tauri) app it doubles as the window title bar, with dedicated
// drag regions around the interactive search field and buttons.
export const TopBar = ({ hideSearch = false }: TopBarProps) => {
  const desktop = isDesktopApp()
  const { goBack, goForward, canBack, canForward } = useHistoryNav()

  useRecordRecentChannelVisits()

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

      {hideSearch ? <div className="admin-topbar-spacer" /> : <TopBarSearch />}

      {desktop ? (
        <div aria-hidden="true" className="admin-topbar-drag-zone" data-tauri-drag-region />
      ) : null}

      <div className="flex items-center gap-1">
        <AlertsBell />
        <WorkspaceBadge />
        <Link aria-label="Help & feedback" className="admin-topbar-btn" title="Help & feedback" to="/feedback">
          <Help />
        </Link>
      </div>
    </header>
  )
}
