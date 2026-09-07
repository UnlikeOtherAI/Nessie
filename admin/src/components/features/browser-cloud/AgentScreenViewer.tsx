import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { BROWSER_VIEWPORT_PRESETS, type BrowserViewport } from '@nessie/schemas'

import {
  useCloudBrowserSession,
  useEndResumedSession,
  useKeepBrowserAlive,
  useSendBrowserHome,
  useSetAgentBrowserViewport,
  type BrowserControl,
} from '../../../facades/browser-cloud/hooks'
import { browserCountdown, formatCountdown } from './session-countdown'
import { useBrowserShareBanner } from './browser-share-banner'
import {
  isCurrentLiveViewDisconnect,
  liveViewRecoveryMessage,
  liveViewStatusLabel,
  recoveryForLiveViewError,
  type LiveViewRecovery,
} from './live-view-recovery'
import { BrowserPreviewStatus } from './browser-preview-status'
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
  const keepAlive = useKeepBrowserAlive(sessionId)

  // Ticks only while a resumed session is on screen: an agent's own session is
  // ended by its run, so there is no idle window to count down and nothing to
  // ask the reader for.
  const [now, setNow] = useState(() => Date.now())
  const countdownFor = session.data?.runId === null ? session.data?.expiresAt : null
  useEffect(() => {
    if (!countdownFor) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [countdownFor])
  const countdown = browserCountdown(countdownFor, now)
  const setViewport = useSetAgentBrowserViewport(threadId, agent?.id ?? null)
  // Whether signing in here signs in for other people is the session's answer.
  // Reading it off the agent's visibility said "shared" for every browser a
  // team agent owned — including the Personal Assistant's, which since the
  // per-principal browsers is one jar per person and shared with nobody.
  const shared = session.data?.shared ?? false
  const { dismiss: dismissBanner, dismissed: bannerDismissed } = useBrowserShareBanner(agent?.id)

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
  const [heldFrame, setHeldFrame] = useState<{ key: string; url: string; version: number } | null>(null)
  const iframe = useRef<HTMLIFrameElement | null>(null)
  const frameVersion = useRef(0)
  const [recovery, setRecovery] = useState<LiveViewRecovery>('idle')
  const frameKey = `${sessionId}::${activeTab}`
  const frameUrl = live && recovery !== 'terminal' && recovery !== 'denied'
    ? heldFrame?.url ?? null
    : null
  const frameOrigin = useMemo(() => {
    if (!frameUrl) return null
    try {
      return new URL(frameUrl).origin
    } catch {
      return null
    }
  }, [frameUrl])

  // Keep the initial and tab-selected frame stable across ordinary polls, but
  // never restore an old URL while a recovery request is pending.
  useEffect(() => {
    if (!live) {
      setHeldFrame(null)
      return
    }
    if (recovery === 'idle' && mintedUrl !== null) {
      setHeldFrame((current) => current?.key === frameKey
        ? current
        : { key: frameKey, url: mintedUrl, version: frameVersion.current++ })
    }
  }, [frameKey, live, mintedUrl, recovery])

  // React Query retains the last successful detail while a poll is failing.
  // That is useful for ordinary transient outages, but never for a revoked
  // viewer: an old provider URL remains capable until its own expiry. Clear it
  // as soon as the current poll says this caller no longer has access.
  useEffect(() => {
    if (!session.isError) return
    const next = recoveryForLiveViewError(session.error)
    if (next === 'denied' || next === 'terminal') {
      setHeldFrame(null)
      setRecovery(next)
    }
  }, [session.error, session.isError])

  const recoverLiveView = useCallback(async () => {
    setRecovery('loading')
    setHeldFrame(null)
    const answer = await session.refetch()
    if (answer.isError) {
      setRecovery(recoveryForLiveViewError(answer.error))
      return
    }
    const detail = answer.data
    const refreshedLive = detail?.status === 'active' || detail?.status === 'allocating'
    const refreshedTab = detail?.tabs.find((tab) => tab.id === activeTab)
    const refreshedUrl = refreshedTab?.liveViewUrl ?? detail?.liveViewUrl ?? null
    if (!refreshedLive) {
      setRecovery('terminal')
      return
    }
    if (!refreshedUrl) {
      setRecovery('retryable')
      return
    }
    setHeldFrame({ key: frameKey, url: refreshedUrl, version: frameVersion.current++ })
    setRecovery('idle')
  }, [activeTab, frameKey, session])

  // Live View tells its embedding page when Browserbase has disconnected. A
  // same-origin check alone is insufficient: another Browserbase frame could
  // otherwise make this viewer discard its own URL. Bind the event to the
  // exact iframe as well as the URL we minted for it.
  useEffect(() => {
    if (!frameOrigin) return undefined
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!isCurrentLiveViewDisconnect(event, frameOrigin, iframe.current?.contentWindow)) return
      void recoverLiveView()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameOrigin, recoverLiveView])

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
    void recoverLiveView()
  }
  const retryable = recovery === 'retryable'
    || (session.isError && recoveryForLiveViewError(session.error) === 'retryable')
  const recoveryMessage = liveViewRecoveryMessage(!session.isLoading && session.data !== undefined && !live ? 'terminal' : recovery)
  const emptyStateMessage = recovery === 'loading'
    ? 'Requesting a fresh live view…'
    : recoveryMessage ?? (retryable
      ? live
        ? 'The live view could not be refreshed. Retry to request a fresh view.'
        : 'This browser has closed.'
      : session.isLoading
        ? 'Connecting to the browser…'
        : live
          ? 'The browser is starting up.'
          : 'This browser has closed.')
  const previewStatus = recovery === 'loading'
    ? 'Refreshing the live view…'
    : retryable
      ? 'Live view disconnected.'
      : !live
        ? 'This browser has closed.'
        : control.controlling
          ? 'You are driving.'
          : 'Take control to use this browser.'
  const previewDisclosure = shared ? ' Saved sign-ins are shared.' : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 px-4 py-2">
        <span className="truncate text-sm font-medium text-[color:var(--tx)]">
          {session.data?.agentName ?? 'Agent'}
        </span>
        {variant === 'fullscreen' ? (
          <>
            <Pill size="sm" tone={live ? 'success' : 'muted'}>
              {liveViewStatusLabel(session.data?.status ?? '')}
            </Pill>
            {session.data?.controlledByUserId ? (
              <Pill size="sm" tone="warning">
                {control.controlling ? 'You are driving' : 'Someone is driving'}
              </Pill>
            ) : null}
          </>
        ) : null}
        {live ? (
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
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

      {variant === 'fullscreen' && shared && (control.controlling || !bannerDismissed) ? (
        <div className="mx-3 mb-2 flex flex-shrink-0 items-start gap-3 border border-[color:var(--sep)] bg-[color:var(--bg2)] px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-[color:var(--tx2)]">
            The people who signed in to this browser, and the person who requested this
            session, can view its saved state. Anything you sign in to here is shared with them.
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

      {/* Still offered at zero. The clock here is the reader's, the expiry is
          the server's, and the reaper is the only thing that actually ends a
          session — so hiding the button the moment this clock says zero takes
          the rescue away exactly when it is needed, and a client running a
          minute fast never sees it at all. If the session really has gone the
          press is answered by a 404 and the panel moves on. */}
      {variant === 'fullscreen' && countdown?.warning ? (
        <div
          aria-live="polite"
          className="mx-3 mb-2 flex flex-shrink-0 items-center gap-3 border border-[color:var(--warning)] bg-[color:var(--bg2)] px-3 py-2"
        >
          <p className="min-w-0 flex-1 text-xs text-[color:var(--tx2)]">
            {countdown.expired ? (
              <>This browser is closing. Anything signed in is saved.</>
            ) : (
              <>
                This browser closes in{' '}
                <span className="font-mono font-semibold text-[color:var(--tx)]">
                  {formatCountdown(countdown.secondsLeft)}
                </span>
                {' '}unless you are still using it. Anything signed in is saved either way.
              </>
            )}
          </p>
          <button
            className="admin-button admin-button-primary admin-button-compact"
            disabled={keepAlive.isPending}
            onClick={() => keepAlive.mutate()}
            type="button"
          >
            {keepAlive.isPending ? 'Keeping…' : 'Continue'}
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[color:var(--bg2)]">
        {frameUrl ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            className="h-full w-full border-0"
            key={heldFrame?.version}
            // What the provider's live view needs and no more: its own scripts
            // and origin, and forms so a sign-in can submit in control mode.
            // Watch-only is the pointer-events line below, not this.
            sandbox="allow-same-origin allow-scripts allow-forms"
            ref={iframe}
            src={frameUrl}
            style={{ pointerEvents: control.controlling ? 'auto' : 'none' }}
            title={`${session.data?.agentName ?? 'Agent'} browser`}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[color:var(--tx2)]">
            {emptyStateMessage}
          </div>
        )}
        {frameUrl ? (
          <BrowserPreviewStatus
            countdown={countdown?.warning
              ? { expired: countdown.expired, secondsLeft: countdown.secondsLeft }
              : null}
            disclosure={previewDisclosure}
            onContinue={() => keepAlive.mutate()}
            pending={keepAlive.isPending}
            status={previewStatus}
            variant={variant}
          />
        ) : null}
        {retryable && live ? (
          <button
            className="absolute bottom-4 left-1/2 -translate-x-1/2 admin-button admin-button-primary"
            onClick={reloadFrame}
            type="button"
          >
            Retry live view
          </button>
        ) : null}
      </div>

      {variant === 'fullscreen' ? (
        <p className="flex-shrink-0 px-4 py-2 text-xs text-[color:var(--tx3)]">
          {claimFailed
            ? 'Couldn’t take control — try Take control above.'
          : setViewport.data?.appliedToLiveSession === false
            ? `Saved ${setViewport.variables?.width}×${setViewport.variables?.height}. `
              + 'This browser keeps the window it opened with; the next one opens at the '
              + 'new size.'
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
