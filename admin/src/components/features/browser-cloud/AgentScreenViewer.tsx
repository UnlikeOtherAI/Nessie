import { useEffect, useMemo, useRef, useState } from 'react'

import {
  useBrowserControl,
  useCloudBrowserSession,
  useEndResumedSession,
} from '../../../facades/browser-cloud/hooks'
import { useTabParam } from '../../../navigation/useTabParam'
import { Pill } from '../../primitives/Pill'
import { TabBar } from '../../primitives/TabBar'

type AgentScreenViewerProps = {
  sessionId: string
  /** Full-screen gets more chrome and a bigger frame; the panel is compact. */
  variant: 'panel' | 'fullscreen'
  /**
   * Take the controls as soon as the session is live. Set when the person
   * opened the browser for themselves — a resume — where waiting for a second
   * press of "Take control" is a step nobody asked for. Never set for a
   * session an agent is driving.
   */
  claimOnLive?: boolean
  /** The conversation this is shown in; "Done" refetches through it. */
  threadId?: string | null
  /** Leave full screen once a resumed session has been ended. */
  onDone?: () => void
  /**
   * The agent whose browser this is, when known. A team agent's browser
   * is shared with everyone who can reach it, which the banner says before
   * anybody types into it.
   */
  agent?: { id: string; visibility?: 'team' | 'private' }
}

/**
 * Dismissal is per (viewer, agent) and deliberately client-local: it is a
 * reminder, not a consent record, and the sentence returns undismissed while
 * somebody is actually driving, where it is load-bearing.
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
 * Watch-only until somebody claims control — `pointer-events: none` keeps a
 * stray click out of the agent's browser. That is a courtesy, not the security
 * boundary: the boundary is who may fetch the live-view URL at all, which the
 * detail route decides. The claim is what makes the *agent* stand down, since
 * every browser verb is refused server-side while it is held.
 */
export const AgentScreenViewer = ({
  agent,
  claimOnLive = false,
  onDone,
  sessionId,
  threadId = null,
  variant,
}: AgentScreenViewerProps) => {
  const session = useCloudBrowserSession(sessionId)
  // A session with no run is one a person opened: nobody is watching through
  // it, nobody is paused, and "done" means the browser saves where it is and
  // stops — not "hand back to the agent".
  const resumed = session.data?.runId === null
  const endResumed = useEndResumedSession(threadId, agent?.id ?? null)
  // Control is only offered full-screen: the panel is a glance, and handing
  // somebody the keyboard in a 400px column is not the affordance.
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

  // Once, when the session first reports live and nobody else holds it. The
  // ref rather than state, so a failed claim does not retry on every poll —
  // the failure is shown instead, and the ordinary button stays available.
  const claimed = useRef(false)
  const { take } = control
  useEffect(() => {
    if (!claimOnLive || variant !== 'fullscreen' || claimed.current) return
    if (session.data?.status !== 'active' || session.data.controlledByUserId) return
    claimed.current = true
    take()
  }, [claimOnLive, session.data, take, variant])
  const claimFailed = claimOnLive && claimed.current && !control.controlling && control.error !== null

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
          <Pill size="sm" tone="warning">
            {control.controlling ? 'You are driving' : 'Someone is driving'}
          </Pill>
        ) : null}
        {variant === 'fullscreen' && live ? (
          <span className="ml-auto flex items-center gap-2">
            {resumed && control.controlling ? (
              <button
                className="admin-button admin-button-primary admin-button-compact"
                disabled={endResumed.isPending}
                onClick={() => endResumed.mutate(sessionId, { onSuccess: onDone })}
                type="button"
              >
                {endResumed.isPending ? 'Saving…' : 'Done'}
              </button>
            ) : (
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                disabled={control.pending
                  || (Boolean(session.data?.controlledByUserId) && !control.controlling)}
                onClick={() => (control.controlling ? control.handBack() : control.take())}
                type="button"
              >
                {control.controlling ? 'Hand back' : 'Take control'}
              </button>
            )}
          </span>
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

      {shared && (control.controlling || !bannerDismissed) ? (
        <div className="mx-3 mb-2 flex flex-shrink-0 items-start gap-3 border border-[color:var(--sep)] bg-[color:var(--bg2)] px-3 py-2">
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
            // What the provider's live view needs and no more: its own scripts
            // and origin, and forms so a sign-in can submit in control mode.
            // Watch-only is the pointer-events line below, not this.
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
          {claimFailed
            ? 'Couldn’t take control — try Take control above.'
            : resumed
              ? control.controlling
                ? 'You are driving. What you type goes straight to the browser — it never '
                  + 'passes through this team. Press Done when you are finished; the browser '
                  + 'saves where you left off.'
                : 'Nobody is driving this browser. Take control to use it.'
              : control.controlling
                ? 'You are driving. The agent is paused until you hand back. What you type '
                  + 'goes straight to the browser — it never passes through this team, '
                  + 'and the agent cannot read it.'
                : 'You are watching what the agent sees. Pages load directly from the browser '
                  + 'provider, so their content never passes through this team.'}
        </p>
      ) : null}
    </div>
  )
}
