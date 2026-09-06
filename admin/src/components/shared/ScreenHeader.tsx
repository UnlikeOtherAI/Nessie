import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useLocalBackSnapshot } from '../../navigation/LocalBackContext'
import { usePhoneNavigation } from '../../layouts/admin-shell/PhoneNavigationProvider'
import { useScreenBarLayerKey } from '../../navigation/ScreenBarLayer'
import { useScreenBarPublisher } from '../../navigation/useScreenBar'
import type { ScreenBarBack } from '../../navigation/screen-bar'
import { toScreenBarActions } from './screen-bar-actions'
import { PhoneBackButton } from '../../navigation/PhoneBackButton'
import { PhoneNavigationButton } from '../../navigation/PhoneNavigationButton'
import { useNativeIOSPhoneApp, useNavigationLayout } from '../../navigation/mobile-shell'
import { publishScreenTitle, retireScreenTitle } from '../../navigation/screen'
import { surfaceParent } from '../../navigation/surface-lookup'
import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from './ResponsivePageHeader'

// The one header every screen renders (docs/navigation/overview.md §9, plan §4.9).
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
  const navigation = usePhoneNavigation()
  // The iOS shell draws this bar natively, so the web must not draw a second
  // one beneath it. Nothing else changes: mobile Safari at any width, the
  // Android app, iPad and desktop all read false here and take the path below
  // unchanged.
  const nativeBar = useNativeIOSPhoneApp() && single
  const barLayerKey = useScreenBarLayerKey()
  // Subscribing re-runs the published Back when an owner registers or leaves,
  // exactly as the rendered doorway does.
  useLocalBackSnapshot()

  // Published under this header's own pathname: retained and seeded layers
  // stay mounted under their own location, so several headers publish at
  // once and the shell reads the one for the live route.
  const pathname = location.pathname
  useEffect(() => {
    publishScreenTitle(pathname, title)
    return () => { retireScreenTitle(pathname, title) }
  }, [pathname, title])

  // What the native bar publishes as Back is the Back this header would
  // actually run — not the resolver's answer. A Flow that owns its Back
  // returns to an address the registry cannot know (a compose's `returnTo`,
  // a designer's edit origin); running the resolver there pops to the section
  // root instead of where the reader came from.
  const resolvedBack = navigation?.resolveBackAction(pathname) ?? null
  const effectiveBack: ScreenBarBack | null = flowOwnsBack && onBack
    ? { label: backLabel ?? `Back from ${title}`, onBack }
    : resolvedBack
      ? { label: resolvedBack.label, onBack: () => navigation?.performBack() }
      : null
  // Only the iOS shell reads this, so only it pays for building it. Every
  // other surface keeps the render it always had.
  // A screen whose title *is* an editable field (the workflow designer) names
  // itself by that field's value: the bar says which workflow, not "Workflow
  // Designer". The placeholder stands in before the reader has typed one.
  const barTitle = titleInput ? titleInput.value || titleInput.placeholder : title
  useScreenBarPublisher(
    { actions: toScreenBarActions(actions), back: effectiveBack, title: barTitle },
    nativeBar,
  )

  const pageBack = onBack && (flowOwnsBack || surfaceParent(pathname) !== null)
    ? (
      <PhoneBackButton
        label={backLabel ?? `Back from ${title}`}
        onBack={onBack}
      />
    )
    : null

  if (singleLayoutOnly && !single) return null

  // A header with no layer beneath it — a screen rendered outside the stack —
  // has nothing to publish to, so it keeps drawing rather than disappearing.
  if (nativeBar && barLayerKey !== null) {
    // The heading stays, and stays an `h1`: the settle focuses it and the
    // live region reads its text content (navigation/settle.ts), both by
    // `querySelector('h1')`. `sr-only` keeps the element and its text while
    // taking it out of the visual bar the native chrome now owns — removing
    // it would break the announcement silently.
    //
    // `eyebrow`, `leading` and `titleInput` have no lane in a native bar, so
    // they stay with the page rather than being dropped: an agent's avatar, a
    // "System managed" note and the workflow-name field are content, not
    // chrome — and dropping the field would leave no way to rename at all.
    const below = eyebrow || leading || subtitle || tabs || titleInput
    return (
      <>
        <h1 className="sr-only" id={titleId}>{barTitle}</h1>
        {below ? (
          <div className="flex min-w-0 flex-col gap-2 px-4 pb-2 pt-3">
            {titleInput ? (
              <input
                aria-label={titleInput.ariaLabel}
                className={[
                  'w-full min-w-0 truncate border-0 bg-transparent p-0 text-[17px] font-bold',
                  'text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)]',
                ].join(' ')}
                onChange={(event) => titleInput.onChange(event.target.value)}
                placeholder={titleInput.placeholder}
                value={titleInput.value}
              />
            ) : null}
            {eyebrow || leading ? (
              <div className="flex min-w-0 items-center gap-2">
                {leading}
                {eyebrow ? (
                  <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-[color:var(--tx2)]">
                    {eyebrow}
                  </span>
                ) : null}
              </div>
            ) : null}
            {subtitle ? <div className="min-w-0">{subtitle}</div> : null}
            {tabs ? <div className="min-w-0">{tabs}</div> : null}
          </div>
        ) : null}
      </>
    )
  }

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
