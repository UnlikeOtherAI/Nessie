import { useMemo } from 'react'

import { useCloudBrowserSession } from '../../../facades/browser-cloud/hooks'
import { useTabParam } from '../../../navigation/useTabParam'
import { Pill } from '../../primitives/Pill'
import { TabBar } from '../../primitives/TabBar'

type AgentScreenViewerProps = {
  sessionId: string
  /** Full-screen gets more chrome and a bigger frame; the panel is compact. */
  variant: 'panel' | 'fullscreen'
}

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
export const AgentScreenViewer = ({ sessionId, variant }: AgentScreenViewerProps) => {
  const session = useCloudBrowserSession(sessionId)

  const tabs = useMemo(() => session.data?.tabs ?? [], [session.data])
  const live = session.data?.status === 'active' || session.data?.status === 'allocating'

  // Follow the agent by default: the hook reads an id the session no longer
  // has as its fallback, so when the agent closes the tab being watched the
  // viewer snaps back to the first one rather than pointing at a dead frame.
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs])
  const [activeTab, setActiveTab] = useTabParam('browserTab', tabIds, tabIds[0] ?? '')

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
          <Pill size="sm" tone="warning">Someone is driving</Pill>
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
            value={activeTab}
          />
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[color:var(--bg2)]">
        {frameUrl ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            className="h-full w-full border-0"
            // Watch-only: a click here must not reach the agent's browser.
            sandbox="allow-same-origin allow-scripts"
            src={frameUrl}
            style={{ pointerEvents: 'none' }}
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
          You are watching what the agent sees. Pages load directly from the browser
          provider, so their content never passes through this workspace.
        </p>
      ) : null}
    </div>
  )
}
