import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AppConnectDialog } from '../components/features/apps/AppConnectDialog'
import { AppDetailHero } from '../components/features/apps/AppDetailHero'
import { AppDetailTabs } from '../components/features/apps/AppDetailTabs'
import { Skeleton } from '../components/primitives/Skeleton'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import {
  appDetailTabIds,
  appDetailTabs,
  appNotFoundMessage,
} from '../components/features/apps/app-detail-view'
import { useRemoveAppConnections } from '../facades/apps/connect-hooks'
import { useApp } from '../facades/apps/hooks'
import { usePhoneNavigation } from '../layouts/admin-shell/PhoneNavigationProvider'
import { usePhoneLayout } from '../lib/mobile-shell'
import { useTabParam } from '../navigation/useTabParam'

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
  const [removeOpen, setRemoveOpen] = useState(false)
  const removeApp = useRemoveAppConnections()
  const phoneLayout = usePhoneLayout()
  const phoneNavigation = usePhoneNavigation()
  // Called before the loading/absent early returns, as every hook must be.
  // With no app yet the offered list is empty, so `?tab=` reads as Overview
  // until the record arrives and then resolves against the real tabs.
  const tabIds = useMemo(
    () => (app ? appDetailTabIds(appDetailTabs(app)) : []),
    [app],
  )
  // The tab lives in the URL so `?tab=accounts` is linkable, and it is written
  // with `replace` so flipping tabs never enters history
  // (docs/navigation.md §1, "Tab hosts").
  const [activeTab, selectTab] = useTabParam('tab', tabIds, 'overview')

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

  // One header for every state of this screen — loading, not found, and the
  // app itself — so Back never disappears with the content. The wide-layout
  // Back is the page's own, because Apps owns this detail's parent; on a
  // phone the shared doorway resolves it through the one Back resolver.
  const header = (
    <ScreenHeader
      backLabel="Back to Apps"
      onBack={backToList}
      title={app?.name ?? 'App'}
    />
  )

  if (!app) {
    return (
      <div className="flex h-full min-w-0 flex-col overflow-x-hidden">
        {header}
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pb-8">
          {isPending ? (
            <Skeleton variant="detail" />
          ) : (
            <div className="flex flex-1 items-center justify-center py-16 text-sm text-[color:var(--tx3)]">
              {appNotFoundMessage(false)}
            </div>
          )}
        </div>
      </div>
    )
  }

  const closeRemove = () => {
    if (removeApp.isPending) return
    removeApp.reset()
    setRemoveOpen(false)
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden">
      {header}
      {/*
        Full-bleed to match /apps and the agents detail page. The reading
        measure that a centred column was providing belongs on the prose
        itself — AppDetailHero caps its description — not on the whole page,
        which also has to hold a capability table and an accounts list that
        genuinely want the width.
      */}
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="grid min-w-0 w-full gap-6 px-4 pb-10 sm:px-6 lg:px-8">
          <AppDetailHero
            app={app}
            onConnect={() => setConnectOpen(true)}
            onRemove={() => {
              removeApp.reset()
              setRemoveOpen(true)
            }}
            removing={removeApp.isPending}
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
      <ConfirmDialog
        body={(
          <>
            <p>
              This disconnects every account for this app. Agents will no longer be able to use it.
            </p>
            {removeApp.isError ? (
              <p className="mt-3 text-sm text-[color:var(--danger-text)]" role="alert">
                We couldn&apos;t remove this app. Try again.
              </p>
            ) : null}
          </>
        )}
        confirmLabel={removeApp.isPending ? 'Removing…' : 'Remove'}
        destructive
        onCancel={closeRemove}
        onConfirm={() => {
          removeApp.mutate(app.connections.map((connection) => connection.id), {
            onSuccess: () => setRemoveOpen(false),
          })
        }}
        open={removeOpen}
        pending={removeApp.isPending}
        title={`Remove ${app.displayName}?`}
      />
    </div>
  )
}
