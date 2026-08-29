import { faChevronLeft } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
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

/**
 * One app, as a full page at `/apps/:slug`.
 *
 * A page rather than a drawer, for the reason the agent detail page settled on
 * the same shape: a connected app is a durable object with durable substates
 * (accounts, agent access), so every one of them has to survive a refresh, work
 * in browser history, and be pasteable to a teammate.
 *
 * Connecting is still the Connectors page's install flow in this phase — the
 * hero's primary control links to the server-supplied `installHref` rather than
 * to a second, half-built flow.
 */
export const AppDetailPage = () => {
  const navigate = useNavigate()
  const { slug } = useParams<{ slug?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: app, isPending } = useApp(slug)

  const backToList = () => void navigate('/apps')

  const header = (
    <header className="flex items-center gap-3 px-6 pt-6 pb-4">
      <PhoneNavigationButton />
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[64rem] gap-6 px-4 pb-10 sm:px-6 lg:px-8">
          <AppDetailHero app={app} onManageAccess={() => selectTab('agents')} />
          <AppDetailTabs activeTab={activeTab} app={app} onSelectTab={selectTab} />
        </div>
      </div>
    </div>
  )
}
