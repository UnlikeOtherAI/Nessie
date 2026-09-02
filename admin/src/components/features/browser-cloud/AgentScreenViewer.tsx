import { useEffect, useMemo, useState } from 'react'

import { useBrowserControl, useCloudBrowserSession } from '../../../facades/browser-cloud/hooks'
import { Pill } from '../../primitives/Pill'
import { TabBar } from '../../primitives/TabBar'

type AgentScreenViewerProps = {
  sessionId: string
  /** Full-screen gets more chrome and a bigger frame; the panel is compact. */
  variant: 'panel' | 'fullscreen'
  /**
   * The agent whose browser this is, when known. A workspace agent's browser
   * is shared with everyone who can reach it, which the banner says before
   * anybody types into it.
   */
  agent?: { id: string; visibility?: 'workspace' | 'private' }
}

/**
 * Dismissal is per (viewer, agent) and deliberately client-local: it is a
 * reminder, not a consent record, and the sentence returns undismissed in the
 * sign-in handoff where it is actually load-bearing.
 */
const bannerStorageKey = (agentId: string): string =>
  `nessie.browserShareBanner.${agentId}`

const STATUS_LABEL: Record<string, string> = {
  allocating: 'Starting',
  active: 'Live',
  releasing: 'Closing',
  released: 'Closed',
  failed: 'Failed',
  unknown: 'Unknown',
}

/**
 * The one browser viewer: live-view iframe, our own tab strip, and a status
 * line. Mounted by the screen panel and by the full-screen takeover, so the
 * two can never drift into different browsers.
 *
 * Watch-only in phase 1 — `pointer-events: none` keeps a stray click out of
 * the agent's browser. That is a courtesy, not the security boundary: the
 * boundary is who may fetch the live-view URL at all, which the detail route
 * decides.
 */
export const AgentScreenViewer = ({ agent, sessionId, variant }: AgentScreenViewerProps) => {
  const session = useCloudBrowserSession(sessionId)
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const control = useBrowserControl(variant === 'fullscreen' ? sessionId : null)
  const shared = agent !== undefined && agent.visibility !== 'private'
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    if (!agent) return true
    try {
      return window.localStorage.getItem(bannerStorageKey(agent.id)) === 'dismissed'
    } catch {
      return false
    }
  })
  const dismissBanner = () => {
    setBannerDismissed(true)
    if (!agent) return
    try {
      window.localStorage.setItem(bannerStorageKey(agent.id), 'dismissed')
    } catch {
      // A viewer with storage blocked simply sees the sentence again.
    }
  }

  const tabs = useMemo(() => session.data?.tabs ?? [], [session.data])
  const live = session.data?.status === 'active' || session.data?.status === 'allocating'

  // Follow the agent by default: when it opens or closes tabs, snap back to
  // the first one rather than leaving the viewer pointed at a dead frame.
  useEffect(() => {
    if (tabs.length === 0) {
      setActiveTab(null)
      return
    }
    if (!activeTab || !tabs.some((tab) => tab.id === activeTab)) {
      setActiveTab(tabs[0]?.id ?? null)
    }
  }, [tabs, activeTab])

  const frameUrl = useMemo(() => {
    if (!session.data) return null
    const chosen = tabs.find((tab) => tab.id === activeTab)
    return chosen?.liveViewUrl ?? session.data.liveViewUrl
  }, [session.data, tabs, activeTab])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 px-4 py-2">
        <span className="truncate text-sm font-medium text-[color:var(--tx)]">
          {session.data?.agentName ?? 'Agent'}
        </span>
        <Pill size="sm" tone={live ? 'success' : 'muted'}>
          {STATUS_LABEL[session.data?.status ?? ''] ?? 'Loading'}
        </Pill>
        {session.data?.controlledByUserId ? (
          <Pill size="sm" tone="warning">
            {control.controlling ? 'You are driving' : 'Someone is driving'}
          </Pill>
        ) : null}
        {variant === 'fullscreen' && live ? (
          <button
            className="admin-button admin-button-secondary admin-button-compact ml-auto"
            disabled={control.pending
              || (Boolean(session.data?.controlledByUserId) && !control.controlling)}
            onClick={() => (control.controlling ? control.handBack() : control.take())}
            type="button"
          >
            {control.controlling ? 'Hand back' : 'Take control'}
          </button>
        ) : null}
      </div>

      {tabs.length > 1 ? (
        <div className="flex-shrink-0 px-3 pb-2">
          <TabBar
            ariaLabel="Browser tabs"
            items={tabs.map((tab) => ({
              label: tab.title || tab.url || 'Tab',
              title: tab.url,
              value: tab.id,
            }))}
            onChange={setActiveTab}
            size="sm"
            value={activeTab ?? tabs[0]?.id ?? ''}
          />
        </div>
      ) : null}

      {shared && (control.controlling || !bannerDismissed) ? (
        <div className="mx-3 mb-2 flex flex-shrink-0 items-start gap-3 rounded-[var(--radius-sm)] border border-[color:var(--warning-border,var(--sep))] bg-[color:var(--warning-soft,var(--bg2))] px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-[color:var(--tx2)]">
            Other people can use this agent’s browser. Anything you sign in to here is
            shared with everyone who has access to this agent.
          </p>
          <button
            className="text-xs text-[color:var(--lnk)] hover:underline"
            onClick={dismissBanner}
            type="button"
          >
            Got it
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[color:var(--bg2)]">
        {frameUrl ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            className="h-full w-full border-0"
            // Watch-only: a click here must not reach the agent's browser.
            sandbox="allow-same-origin allow-scripts allow-forms"
            src={frameUrl}
            style={{ pointerEvents: control.controlling ? 'auto' : 'none' }}
            title={`${session.data?.agentName ?? 'Agent'} browser`}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[color:var(--tx2)]">
            {session.isLoading
              ? 'Connecting to the browser…'
              : live
                ? 'The browser is starting up.'
                : 'This browser has closed.'}
          </div>
        )}
      </div>

      {variant === 'fullscreen' ? (
        <p className="flex-shrink-0 px-4 py-2 text-xs text-[color:var(--tx3)]">
          {control.controlling
            ? 'You are driving. The agent is paused until you hand back. What you type '
              + 'goes straight to the browser — it never passes through this workspace, '
              + 'and the agent cannot read it.'
            : 'You are watching what the agent sees. Pages load directly from the browser '
              + 'provider, so their content never passes through this workspace.'}
        </p>
      ) : null}
    </div>
  )
}
