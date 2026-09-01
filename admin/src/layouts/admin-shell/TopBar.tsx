import { isDesktopApp } from '../../lib/desktop'
import { AlertsBell } from './AlertsBell'
import { TopBarSearch } from './TopBarSearch'
import { RecentChannelsControl, useHistoryNav } from './topbar-navigation'
import { UserMenuTrigger } from './UserMenuTrigger'

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

type TopBarProps = {
  hideSearch?: boolean
  onLogout: () => void
  showAccountMenu: boolean
}

// Slack-style global top bar. Rendered full-width above the rail and content. On
// the desktop (Tauri) app it doubles as the window title bar, with dedicated
// drag regions around the interactive search field and buttons.
export const TopBar = ({ hideSearch = false, onLogout, showAccountMenu }: TopBarProps) => {
  const desktop = isDesktopApp()
  const { goBack, goForward, canBack, canForward } = useHistoryNav()

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
        <RecentChannelsControl />
      </div>

      {desktop ? (
        <div aria-hidden="true" className="admin-topbar-drag-zone" data-tauri-drag-region />
      ) : null}

      {hideSearch ? <div className="admin-topbar-spacer" /> : <TopBarSearch />}

      {desktop ? (
        <div aria-hidden="true" className="admin-topbar-drag-zone" data-tauri-drag-region />
      ) : null}

      <div className="flex items-center gap-6">
        <AlertsBell />
        {showAccountMenu ? <UserMenuTrigger onLogout={onLogout} placement="topbar" /> : null}
      </div>
    </header>
  )
}
