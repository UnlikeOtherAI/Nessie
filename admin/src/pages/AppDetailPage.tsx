import { faChevronLeft } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AppDetailHero } from '../components/features/apps/AppDetailHero'
import { AppDetailTabs } from '../components/features/apps/AppDetailTabs'
import { AppDetailSkeleton } from '../components/features/apps/AppSkeletons'
import { ConnectProgress } from '../components/features/apps/ConnectProgress'
import {
  appConnectInFlight,
  appCredentialsHref,
  appDetailTabs,
  appNotFoundMessage,
  resolveAppDetailTab,
  type AppDetailTab,
} from '../components/features/apps/app-detail-view'
import { useAppConnectFlow } from '../facades/apps/connect-hooks'
import { useApp } from '../facades/apps/hooks'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'
import { usePhoneNavigation } from '../layouts/admin-shell/PhoneNavigationProvider'
import { usePhoneLayout } from '../lib/mobile-shell'

/**
 * One app, as a full page at `/apps/:slug`.
 *
 * A page rather than a drawer, for the reason the agent detail page settled on
 * the same shape: a connected app is a durable object with durable substates
 * (accounts, agent access), so every one of them has to survive a refresh, work
 * in browser history, and be pasteable to a teammate.
 *
 * It is also where connecting happens. The hero's primary control runs the
 * connect flow in place and the progress panel renders under it, so a person
 * decides and acts on one screen instead of being handed to the Connectors
 * page's install dialog — the owner's governance surface, which asks questions
 * (scope, transport, credentials) a member connecting an app for themselves has
 * no reason to answer.
 */
export const AppDetailPage = () => {
  const navigate = useNavigate()
  const { slug } = useParams<{ slug?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: app, isPending } = useApp(slug)
  // Keyed by the route parameter, exactly as the detail read is: the connect
  // endpoint takes the same identifier, and the flow re-reads the app through
  // the same cache entry this page renders from.
  const connect = useAppConnectFlow({ slug: slug ?? '' })
  const phoneLayout = usePhoneLayout()
  const phoneNavigation = usePhoneNavigation()

  // Apps owns this detail's immediate parent. On a phone use the shell's
  // ledger-aware action so the labelled Apps doorway, an edge swipe, and
  // Android hardware Back all pop or replace consistently. Wider layouts
  // retain the page's direct list action.
  const backToList = () => {
    if (phoneLayout && phoneNavigation) {
      phoneNavigation.performBack()
      return
    }
    void navigate('/apps')
  }

  const header = (
    <header className="flex items-center gap-3 px-6 pt-6 pb-4">
      {/* This is the one visible phone Back doorway. Rendering the shell's
          circular control beside it created two actions with different
          destinations (Admin and Apps). */}
      {!phoneLayout ? <PhoneNavigationButton /> : null}
      <button
        className="admin-button admin-button-secondary gap-1.5"
        data-testid="app-detail-back"
        onClick={backToList}
        type="button"
      >
        <FontAwesomeIcon className="h-3 w-3" icon={faChevronLeft} />
        Apps
      </button>
    </header>
  )

  if (!app) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
          {isPending ? (
            <AppDetailSkeleton />
          ) : (
            <div className="flex flex-1 items-center justify-center py-16 text-sm text-[color:var(--tx3)]">
              {appNotFoundMessage(false)}
            </div>
          )}
        </div>
      </div>
    )
  }

  const tabs = appDetailTabs(app)
  const activeTab = resolveAppDetailTab(searchParams.get('tab'), tabs)

  // The tab lives in the URL so `?tab=accounts` is linkable, and `replace` keeps
  // tab-flipping out of the back button's history.
  const selectTab = (tab: AppDetailTab) => {
    const params = new URLSearchParams(searchParams)
    if (tab === 'overview') params.delete('tab')
    else params.set('tab', tab)
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      {header}
      {/*
        Full-bleed to match /apps and the agents detail page. The reading
        measure that a centred column was providing belongs on the prose
        itself — AppDetailHero caps its description — not on the whole page,
        which also has to hold a capability table and an accounts list that
        genuinely want the width.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid w-full gap-6 px-4 pb-10 sm:px-6 lg:px-8">
          <AppDetailHero
            app={app}
            connectInFlight={appConnectInFlight(connect.state.phase)}
            // The caller's own scope: connecting an app for yourself is what
            // every member may do without asking. A shared install is an
            // owner's decision and stays on the Connectors page, which is
            // where the scope picker lives.
            onConnect={() => connect.connect({ scopeType: 'user' })}
            onManageAccess={() => selectTab('agents')}
          />
          {/* Directly under the hero, never a toast: the person is deciding
              about this app and the page they are reading is the context.
              Renders nothing while idle, so the grid gap does not open. */}
          <ConnectProgress
            appName={app.displayName}
            credentialsHref={appCredentialsHref(app)}
            onDismiss={connect.dismiss}
            onReopenAuthorization={connect.reopenAuthorization}
            onRetry={connect.retry}
            // No `providerName`: `vendor` is the publisher, which is not
            // necessarily who runs the sign-in, and "Waiting for GitHub, Inc.…"
            // claims more than the record knows. The app's own name is true.
            state={connect.state}
          />
          <AppDetailTabs activeTab={activeTab} app={app} onSelectTab={selectTab} />
        </div>
      </div>
    </div>
  )
}
