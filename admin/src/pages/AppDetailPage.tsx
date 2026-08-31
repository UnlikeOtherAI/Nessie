import { faChevronLeft } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AppConnectDialog } from '../components/features/apps/AppConnectDialog'
import { AppDetailHero } from '../components/features/apps/AppDetailHero'
import { AppDetailTabs } from '../components/features/apps/AppDetailTabs'
import { AppDetailSkeleton } from '../components/features/apps/AppSkeletons'
import {
  appDetailTabs,
  appNotFoundMessage,
  resolveAppDetailTab,
  type AppDetailTab,
} from '../components/features/apps/app-detail-view'
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
 * It is also where a person reviews and confirms a connection. Every Apps
 * doorway opens the one shared dialog before it can create an account, so the
 * person sees the app's stated authentication requirements and its audience
 * before the server is contacted.
 */
export const AppDetailPage = () => {
  const navigate = useNavigate()
  const { slug } = useParams<{ slug?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: app, isPending } = useApp(slug)
  const [connectOpen, setConnectOpen] = useState(false)
  const phoneLayout = usePhoneLayout()
  const phoneNavigation = usePhoneNavigation()

  // A custom app's address is checked before it arrives here. Its first
  // connection still waits for this explicit review, so `?connect=true` opens
  // the dialog but never starts a connection by itself.
  useEffect(() => {
    if (searchParams.get('connect') !== 'true') return
    setConnectOpen(true)
    const params = new URLSearchParams(searchParams)
    params.delete('connect')
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

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
            onConnect={() => setConnectOpen(true)}
            onManageAccess={() => selectTab('agents')}
          />
          <AppDetailTabs
            activeTab={activeTab}
            app={app}
            onConnectAnother={() => setConnectOpen(true)}
            onSelectTab={selectTab}
          />
        </div>
      </div>
      <AppConnectDialog app={app} onClose={() => setConnectOpen(false)} open={connectOpen} />
    </div>
  )
}
