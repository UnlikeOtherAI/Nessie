import { useEffect, useMemo, useRef, useState } from 'react'

import { BROWSER_VIEWPORT_PRESETS, type BrowserViewport } from '@nessie/schemas'

import {
  useCloudBrowserSession,
  useEndResumedSession,
  useSendBrowserHome,
  useSetAgentBrowserViewport,
  type BrowserControl,
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
   * The agent whose browser this is, when known. Only used to key the share
   * banner's dismissal — whether the browser is actually shared is the
   * session's answer, not the agent's visibility.
   */
  agent?: { id: string; visibility?: 'team' | 'private' }
  /**
   * The claim, held by the panel rather than by this component. Going full
   * screen and back re-renders the viewer in a different container, and a
   * claim that unmounted with it would hand the keyboard back to the agent
   * every time somebody resized the window they were typing in.
   */
  control: BrowserControl
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
 *
 * The claim itself belongs to the panel, which outlives both faces; both offer
 * it, so shrinking a browser you are driving leaves you still driving it.
 */
export const AgentScreenViewer = ({
  agent,
  claimOnLive = false,
  control,
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
  const sendHome = useSendBrowserHome()
  const setViewport = useSetAgentBrowserViewport(threadId, agent?.id ?? null)
  // Whether signing in here signs in for other people is the session's answer.
  // Reading it off the agent's visibility said "shared" for every browser a
  // team agent owned — including the Personal Assistant's, which since the
  // per-principal browsers is one jar per person and shared with nobody.
  const shared = session.data?.shared ?? false
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
    if (!claimOnLive || claimed.current) return
    if (session.data?.status !== 'active' || session.data.controlledByUserId) return
    claimed.current = true
    take()
  }, [claimOnLive, session.data, take])
  const claimFailed = claimOnLive && claimed.current && !control.controlling && control.error !== null

  // Follow the agent by default: the hook reads an id the session no longer
  // has as its fallback, so when the agent closes the tab being watched the
  // viewer snaps back to the first one rather than pointing at a dead frame.
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs])
  const [activeTab, setActiveTab] = useTabParam('browserTab', tabIds, tabIds[0] ?? '')

  // The URL the provider minted, which is a *fresh* URL on every read.
  const mintedUrl = useMemo(() => {
    if (!session.data) return null
    const chosen = tabs.find((tab) => tab.id === activeTab)
    return chosen?.liveViewUrl ?? session.data.liveViewUrl
  }, [session.data, tabs, activeTab])

  // ...and the one actually in the frame, which must not be.
  //
  // The detail route mints a live-view URL per read and the panel polls, so
  // handing `mintedUrl` straight to `src` swapped the iframe's source every
  // fifteen seconds: the browser reloaded under the reader, losing a
  // half-typed URL and any page state. Both URLs address the same live
  // session, so the first one is kept for as long as it is pointing at the
  // same thing — a new session, a different tab, or the reload button below.
  // A poll that comes back without a URL (a provider hiccup, which the route
  // deliberately renders as "no picture" rather than an error) also leaves
  // the frame alone rather than blanking it.
  const heldFrame = useRef<{ key: string; url: string } | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const frameKey = `${sessionId}::${activeTab}::${reloadNonce}`
  if (!live) heldFrame.current = null
  else if (mintedUrl !== null && heldFrame.current?.key !== frameKey) {
    heldFrame.current = { key: frameKey, url: mintedUrl }
  }
  const frameUrl = heldFrame.current?.url ?? null

  // The size the running session is actually at, which is not always the size
  // the browser is set to: Browserbase fixes a window when the session is
  // created, so a resize the provider would not apply live shows here as the
  // old size until the next open. Naming the size rather than the preset when
  // the two disagree is what keeps that honest.
  const viewport: BrowserViewport | null = session.data?.viewport ?? null
  const presetId = viewport === null
    ? null
    : BROWSER_VIEWPORT_PRESETS.find((option) =>
      option.viewport.width === viewport.width && option.viewport.height === viewport.height,
    )?.id ?? null
  const viewportLabel = viewport === null
    ? 'Window size'
    : `${viewport.width}×${viewport.height}`

  // A held URL outlives its session if the provider retires it, which looks
  // like a frame that has simply stopped. Re-minting is one press away rather
  // than a reason to go back to swapping `src` on a timer.
  const reloadFrame = () => {
    heldFrame.current = null
    setReloadNonce((nonce) => nonce + 1)
    void session.refetch()
  }

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
        {live ? (
          <span className="ml-auto flex items-center gap-2">
            {variant === 'fullscreen' ? (
              <>
                <label className="sr-only" htmlFor="browser-viewport">Window size</label>
                <select
                  // `.admin-input` is full-width by design; in a header row it
                  // is one control among several, so the width is its content's.
                  className="admin-input admin-input-sm w-auto"
                  disabled={setViewport.isPending}
                  id="browser-viewport"
                  onChange={(event) => {
                    const preset = BROWSER_VIEWPORT_PRESETS
                      .find((option) => option.id === event.target.value)
                    if (preset) setViewport.mutate(preset.viewport)
                  }}
                  value={presetId ?? ''}
                >
                  {presetId === null ? (
                    <option value="">{viewportLabel}</option>
                  ) : null}
                  {BROWSER_VIEWPORT_PRESETS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} · {option.viewport.width}×{option.viewport.height}
                    </option>
                  ))}
                </select>
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  disabled={!control.controlling || sendHome.isPending}
                  onClick={() => sendHome.mutate(sessionId)}
                  title={control.controlling
                    ? 'Go to the home page set for this organisation'
                    : 'Take control first'}
                  type="button"
                >
                  {sendHome.isPending ? 'Going…' : 'Home'}
                </button>
                <button
                  aria-label="Reload the live view"
                  className="admin-button admin-button-secondary admin-button-compact"
                  onClick={reloadFrame}
                  type="button"
                >
                  Reload
                </button>
              </>
            ) : null}
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
