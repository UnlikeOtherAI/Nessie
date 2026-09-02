import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { PhoneBackButton } from '../../layouts/admin-shell/PhoneBackButton'
import { PhoneNavigationButton } from '../../layouts/admin-shell/PhoneNavigationButton'
import { useNavigationLayout } from '../../lib/mobile-shell'
import { publishScreenTitle, retireScreenTitle } from '../../navigation/screen'
import { surfaceParent } from '../../navigation/surfaces'
import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from './ResponsivePageHeader'

// The one header every screen renders (docs/navigation.md §9, plan §4.9).
//
// It replaced `AdminPageHeader`, `MobileSectionHeader` and the hand-rolled
// hero and 58px bars each page had grown, which disagreed on height, title
// size, doorway and heading level — five of them returned before any header
// at all, so a phone had no Back on a refused or loading screen.
//
// Three things are its job and nothing else's:
//
//   - **The leading lane.** On the single-column layout it is the shared Back
//     doorway (`PhoneNavigationButton`), which renders the one Back
//     resolver's answer — an open owner, the route's parent, or the menu at a
//     root. On a wide layout the shell keeps its pinned sidebar, so a Back
//     appears only where the page supplies one *and* the registry says the
//     screen has a parent to return to.
//   - **The `h1`.** Required, and the only `h1` on the screen: the settle
//     focuses it and the live region announces it (§12).
//   - **Publishing the screen.** The registry classifies a route but cannot
//     name it, so the rendered title is published to `navigation/screen.ts`,
//     where the shell turns it into `document.title` and the native shell's
//     `nessie:screen` message.
//
// `subtitle` and `tabs` are slots inside the one header block — the hero
// headers' description lines and a Tab host's `TabBar` row — never a second
// header beneath it. The measured leading/actions partition stays in
// `ResponsivePageHeader`, which this composes rather than forks.

export type ScreenHeaderProps = {
  actions?: PageHeaderAction[]
  eyebrow?: string
  // The page's own Back. Rendered on a wide layout only when the registry
  // says this screen has a parent — a root never grows one — unless the
  // screen is a Flow that returns to an address the registry cannot know
  // (`flowOwnsBack`), where it replaces the doorway on every layout.
  onBack?: () => void
  backLabel?: string
  flowOwnsBack?: boolean
  // Extra leading content beside the doorway: the agent avatar, an app icon.
  leading?: ReactNode
  // The two section pages whose wide layout renders the section's own list
  // chrome inline (Knowledge). The screen is still published — the tab title
  // and the native shell name it either way — but the bar paints only where
  // it is the screen's own chrome.
  singleLayoutOnly?: boolean
  subtitle?: ReactNode
  tabs?: ReactNode
  title: string
  titleId?: string
  titleInput?: {
    ariaLabel: string
    onChange: (value: string) => void
    placeholder: string
    value: string
  }
}

export const ScreenHeader = ({
  actions,
  backLabel,
  eyebrow,
  flowOwnsBack = false,
  leading,
  onBack,
  singleLayoutOnly = false,
  subtitle,
  tabs,
  title,
  titleId,
  titleInput,
}: ScreenHeaderProps) => {
  const location = useLocation()
  const layout = useNavigationLayout()
  const single = layout === 'single'

  // Published under this header's own pathname: retained and seeded layers
  // stay mounted under their own location, so several headers publish at
  // once and the shell reads the one for the live route.
  const pathname = location.pathname
  useEffect(() => {
    publishScreenTitle(pathname, title)
    return () => { retireScreenTitle(pathname, title) }
  }, [pathname, title])

  const pageBack = onBack && (flowOwnsBack || surfaceParent(pathname) !== null)
    ? (
      <PhoneBackButton
        label={backLabel ?? `Back from ${title}`}
        onBack={onBack}
      />
    )
    : null

  if (singleLayoutOnly && !single) return null

  return (
    <ResponsivePageHeader
      actions={actions}
      below={subtitle || tabs ? (
        <div className="flex min-w-0 flex-col gap-2">
          {subtitle ? <div className="min-w-0">{subtitle}</div> : null}
          {tabs ? <div className="min-w-0">{tabs}</div> : null}
        </div>
      ) : null}
      eyebrow={eyebrow}
      heading="h1"
      leading={
        <>
          {single && flowOwnsBack && pageBack ? pageBack : <PhoneNavigationButton />}
          {!single && pageBack ? pageBack : null}
          {leading}
        </>
      }
      title={title}
      titleId={titleId}
      titleInput={titleInput}
      titleTone="page"
    />
  )
}
