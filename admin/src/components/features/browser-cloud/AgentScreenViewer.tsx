import { useEffect, useRef, useState } from 'react'
import { BROWSER_VIEWPORT_PRESETS, type BrowserViewport } from '@nessie/schemas'
import {
  useCloudBrowserScreenshot,
  useCloudBrowserSession,
  useEndResumedSession,
  useKeepBrowserAlive,
  useRevokePersonalBrowserAccessGrant,
  useSendBrowserHome,
  useSetAgentBrowserViewport,
  useSetCloudBrowserSessionViewport,
  type BrowserControl,
  type HumanBrowserInput,
  type HumanBrowserKey,
} from '../../../facades/browser-cloud/hooks'
import { browserCountdown } from './session-countdown'
import { BrowserPreviewStatus } from './browser-preview-status'
import { BrowserNavigationControls } from './BrowserNavigationControls'
import { Pill } from '../../primitives/Pill'
import { getBaseUrl } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
type AgentScreenViewerProps = {
  sessionId: string
  variant: 'panel' | 'fullscreen'
  claimOnLive?: boolean
  threadId?: string | null
  onDone?: () => void
  agent?: { id: string; visibility?: 'team' | 'private' }
  control: BrowserControl
}
const specialKey = (key: string): HumanBrowserKey | null => {
  const keys: Record<string, HumanBrowserKey> = {
    ' ': 'Space', Alt: 'Alt', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', Backspace: 'Backspace',
    Delete: 'Delete', End: 'End', Enter: 'Enter', Escape: 'Escape', Home: 'Home',
    PageDown: 'PageDown', PageUp: 'PageUp', Tab: 'Tab',
  }
  return keys[key] ?? null
}
/** Maps a pointer in the displayed screenshot back to the remote viewport. */
const remotePoint = (element: HTMLElement, clientX: number, clientY: number, viewport: BrowserViewport) => {
  const bounds = element.getBoundingClientRect()
  const scale = Math.min(bounds.width / viewport.width, bounds.height / viewport.height)
  const width = viewport.width * scale
  const height = viewport.height * scale
  const left = bounds.left + (bounds.width - width) / 2
  const top = bounds.top + (bounds.height - height) / 2
  return {
    x: Math.max(0, Math.min(viewport.width, (clientX - left) / scale)),
    y: Math.max(0, Math.min(viewport.height, (clientY - top) / scale)),
  }
}
const usePageVisible = (): boolean => {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}
const canvasUrl = (sessionId: string, token: string): string => {
  const base = getBaseUrl()
  const url = base ? new URL(base) : new URL(window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/api/browser-sessions/${sessionId}/canvas`
  url.searchParams.set('token', token)
  return url.toString()
}
/**
 * The one remote-browser viewer for the panel and fullscreen surface.
 *
 * Browserbase never renders in this document. Nessie fetches a short-lived
 * screenshot through the authenticated API and forwards a controller's closed
 * set of gestures over its sealed server-side CDP connection. This makes the
 * visible canvas genuinely read-only for observers instead of relying on CSS
 * to make an interactive provider URL look harmless.
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
  const { token } = useAuthSession()
  const session = useCloudBrowserSession(sessionId)
  const { refetch: refetchSession } = session
  const resumed = session.data?.runId === null
  const live = session.data?.status === 'active' || session.data?.status === 'allocating'
  const pageVisible = usePageVisible()
  const [canvasFrame, setCanvasFrame] = useState<string | null>(null)
  const [canvasConnected, setCanvasConnected] = useState(false)
  const [canvasViewport, setCanvasViewport] = useState<BrowserViewport | null>(null)
  const [canvasTabs, setCanvasTabs] = useState<Array<{ id: string; title: string; url: string }>>([])
  const [canvasRetry, setCanvasRetry] = useState(0)
  const canvasSocket = useRef<WebSocket | null>(null)
  const screenshot = useCloudBrowserScreenshot(sessionId, live && pageVisible && !canvasConnected)
  const endResumed = useEndResumedSession(threadId, agent?.id ?? null)
  const sendHome = useSendBrowserHome()
  const keepAlive = useKeepBrowserAlive(sessionId)
  const revokePrivateAccess = useRevokePersonalBrowserAccessGrant()
  const setViewport = useSetAgentBrowserViewport(threadId, agent?.id ?? null)
  const setSessionViewport = useSetCloudBrowserSessionViewport(sessionId)
  const keyboard = useRef<HTMLTextAreaElement | null>(null)
  const touchGesture = useRef<{ last: { x: number; y: number }; moved: boolean } | null>(null)
  const suppressTouchClick = useRef(false)
  const claimed = useRef(false)
  const inputEpoch = useRef(0)
  const textBuffer = useRef('')
  const textTimer = useRef<number | null>(null)
  const [typedText, setTypedText] = useState('')
  const [inputStopped, setInputStopped] = useState(false)
  const [address, setAddress] = useState('')
  const editingAddress = useRef(false)
  const [now, setNow] = useState(() => Date.now())
  const countdownFor = resumed ? session.data?.expiresAt : null
  // The screenshot HTTP fallback is intentionally preview-only. Human input
  // needs the fresh per-viewer WebSocket, which pins the CDP target while the
  // server rechecks the current lease for every command.
  const canDrive = session.data?.viewerMode === 'controller'
    && session.data?.canControl === true
    && control.controlling && live && canvasConnected && !inputStopped
  const viewport = canvasViewport ?? session.data?.viewport ?? null
  const presetId = viewport === null
    ? null
    : BROWSER_VIEWPORT_PRESETS.find(({ viewport: option }) =>
      option.width === viewport.width && option.height === viewport.height,
    )?.id ?? null
  useEffect(() => {
    if (!live || !pageVisible || !token) return undefined
    const socket = new WebSocket(canvasUrl(sessionId, token))
    canvasSocket.current = socket
    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          imageDataUrl?: unknown
          pageUrl?: unknown
          tabs?: Array<{ id?: unknown; title?: unknown; url?: unknown }>
          type?: string
          viewport?: { height?: unknown; width?: unknown }
        }
        if (payload.type === 'frame' && typeof payload.imageDataUrl === 'string') {
          setCanvasFrame(payload.imageDataUrl)
          if (typeof payload.pageUrl === 'string' && !editingAddress.current) setAddress(payload.pageUrl)
          if (typeof payload.viewport?.width === 'number' && typeof payload.viewport.height === 'number') {
            setCanvasViewport({ height: payload.viewport.height, width: payload.viewport.width })
          }
          if (Array.isArray(payload.tabs)) {
            setCanvasTabs(payload.tabs.flatMap((tab) =>
              typeof tab.id === 'string' && typeof tab.title === 'string' && typeof tab.url === 'string'
                ? [{ id: tab.id, title: tab.title, url: tab.url }]
                : [],
            ))
          }
          setCanvasConnected(true)
        }
      } catch { /* malformed frames close into HTTP fallback */ }
    })
    socket.addEventListener('close', (event) => {
      if (canvasSocket.current === socket) {
        canvasSocket.current = null
        setCanvasConnected(false)
        setCanvasFrame(null)
        setCanvasViewport(null)
        setCanvasTabs([])
        // A CDP failure is ambiguous. Stop the local gesture sequence and let
        // the HTTP preview be a picture only until the fresh socket reconnects.
        if (event.code !== 1000) {
          inputEpoch.current += 1
          setInputStopped(true)
        }
        if (event.code !== 4003 && live && pageVisible && token) {
          window.setTimeout(() => setCanvasRetry((attempt) => attempt + 1), 1_000)
        }
        // The socket can discover a lease expiry before the ordinary detail
        // query polls. Refresh it so an expired owner gets Take control rather
        // than a dead Reconnect affordance.
        void refetchSession()
      }
    })
    return () => {
      if (canvasSocket.current === socket) canvasSocket.current = null
      socket.close()
    }
  }, [canvasRetry, live, pageVisible, refetchSession, sessionId, token])
  useEffect(() => {
    if (!countdownFor) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [countdownFor])
  const countdown = browserCountdown(countdownFor, now)
  const { take } = control
  useEffect(() => {
    const shouldClaim = session.data?.canControl === true
      && session.data?.runId === null
      && claimOnLive
    if (!shouldClaim || claimed.current || session.data?.status !== 'active'
      || session.data.controlledByUserId) return
    claimed.current = true
    take()
  }, [claimOnLive, session.data, take])
  const submit = (input: HumanBrowserInput): void => {
    if (!canDrive) return
    const socket = canvasSocket.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', input }))
      return
    }
    // Never replay through HTTP. A socket that died after accepting a frame
    // is ambiguous, so a fresh control connection starts a new sequence.
    inputEpoch.current += 1
    setInputStopped(true)
  }
  const flushText = (): void => {
    if (textTimer.current !== null) window.clearTimeout(textTimer.current)
    textTimer.current = null
    const text = textBuffer.current
    textBuffer.current = ''
    if (text) submit({ type: 'text', text })
  }
  useEffect(() => () => {
    if (textTimer.current !== null) window.clearTimeout(textTimer.current)
  }, [])
  const focusKeyboard = (): void => keyboard.current?.focus()
  const onCanvasClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (suppressTouchClick.current) {
      suppressTouchClick.current = false
      return
    }
    if (!viewport) return
    const point = remotePoint(event.currentTarget, event.clientX, event.clientY, viewport)
    submit({ type: 'click', ...point })
    focusKeyboard()
  }
  const onCanvasWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (!viewport) return
    event.preventDefault()
    const point = remotePoint(event.currentTarget, event.clientX, event.clientY, viewport)
    submit({ type: 'scroll', ...point, deltaX: event.deltaX, deltaY: event.deltaY })
  }
  const onCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!viewport || event.pointerType !== 'touch') return
    // A drag may not synthesize a click, so it cannot suppress a later tap.
    suppressTouchClick.current = false
    touchGesture.current = {
      last: remotePoint(event.currentTarget, event.clientX, event.clientY, viewport),
      moved: false,
    }
  }
  const onCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!viewport || event.pointerType !== 'touch' || !touchGesture.current) return
    const point = remotePoint(event.currentTarget, event.clientX, event.clientY, viewport)
    const gesture = touchGesture.current
    const deltaX = gesture.last.x - point.x
    const deltaY = gesture.last.y - point.y
    if (!gesture.moved && Math.hypot(deltaX, deltaY) < 6) return
    gesture.moved = true
    suppressTouchClick.current = true
    gesture.last = point
    event.preventDefault()
    submit({ type: 'scroll', ...point, deltaX, deltaY })
  }
  const onCanvasPointerEnd = (): void => {
    if (touchGesture.current?.moved) suppressTouchClick.current = true
    touchGesture.current = null
  }
  const onKeyboard = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Space is ordinary text. Sending a raw space key event to CDP can scroll
    // the page instead of inserting it, which silently joined words in forms.
    if (event.key === ' ') {
      event.preventDefault()
      textBuffer.current += ' '
      if (textTimer.current !== null) window.clearTimeout(textTimer.current)
      textTimer.current = window.setTimeout(flushText, 80)
      return
    }
    const key = specialKey(event.key)
    if (!key) return
    event.preventDefault()
    flushText()
    submit({ type: 'key', key })
  }
  const onTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const text = event.target.value
    setTypedText('')
    if (!text) return
    textBuffer.current += text
    if (textTimer.current !== null) window.clearTimeout(textTimer.current)
    textTimer.current = window.setTimeout(flushText, 80)
  }
  const navigate = (): void => {
    const url = address.trim()
    if (!url) return
    try {
      if (new URL(url).protocol !== 'https:') return
      submit({ type: 'navigate', url })
    } catch { /* the compact field accepts only complete HTTPS addresses */ }
  }
  const previewStatus = !live
    ? 'This browser has closed.'
    : session.data?.canControl === false
      ? 'View only.'
    : inputStopped && session.data?.controlLeaseActive && session.data?.viewerMode === 'controller'
      ? 'Control connection stopped. Reconnect.'
      : inputStopped
        ? 'Control expired. Take control to continue.'
      : session.data?.viewerMode === 'controller' && control.controlling && !canvasConnected
        ? 'Reconnecting controls…'
      : canDrive
      ? 'You are driving.'
      : session.data?.viewerMode === 'controller'
        ? 'Your controls are paused. Take control to continue.'
      : session.data?.controlledByUserId
        ? 'Someone is driving.'
        : 'Take control to use this browser.'
  const emptyState = session.isLoading
    ? 'Connecting to the browser…'
    : !live
      ? 'This browser has closed.'
      : screenshot.isError
        ? 'The remote preview could not be refreshed. Try again in a moment.'
        : 'Preparing the remote preview…'
  const screenshotUrl = canvasFrame ?? screenshot.data?.imageDataUrl ?? null
  const claimFailed = claimOnLive && claimed.current && !control.controlling && control.error !== null
  const heldByAnotherPerson = session.data?.controlLeaseActive === true
    && session.data.viewerMode !== 'controller'
  const viewerHasLiveLease = session.data?.controlLeaseActive === true
    && session.data.viewerMode === 'controller'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 px-4 py-2">
        <span className="truncate text-sm font-medium text-[color:var(--tx)]">
          {session.data?.agentName ?? 'Agent'}
        </span>
        {variant === 'fullscreen' ? (
          <>
            <Pill size="sm" tone={live ? 'success' : 'muted'}>{live ? 'Live' : 'Closed'}</Pill>
            {viewerHasLiveLease ? (
              <Pill size="sm" tone="warning">
                {canDrive ? 'You are driving' : 'Control connection paused'}
              </Pill>
            ) : null}
          </>
        ) : null}
        {live ? (
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {variant === 'fullscreen' ? (
              <BrowserNavigationControls
                address={address}
                canDrive={canDrive}
                homePending={sendHome.isPending}
                onAddressBlur={() => { editingAddress.current = false }}
                onAddressChange={setAddress}
                onAddressFocus={() => { editingAddress.current = true }}
                onBack={() => submit({ type: 'back' })}
                onForward={() => submit({ type: 'forward' })}
                onHome={() => sendHome.mutate(sessionId, {
                  onSuccess: ({ url }) => submit({ type: 'navigate', url }),
                })}
                onNavigate={navigate}
                onReload={() => submit({ type: 'reload' })}
                onSwitchTab={(targetId) => submit({ type: 'switch_tab', targetId })}
                onViewport={(nextViewport) => {
                  if (session.data?.privateAccess) setSessionViewport.mutate(nextViewport)
                  else setViewport.mutate(nextViewport)
                }}
                presetId={presetId}
                tabs={canvasTabs}
                viewport={viewport}
                viewportDisabled={session.data?.privateAccess
                  ? !canDrive || setSessionViewport.isPending
                  : setViewport.isPending}
              />
            ) : null}
            {session.data?.privateAccess ? (
              <button
                className="admin-button admin-button-danger admin-button-compact"
                disabled={revokePrivateAccess.isPending}
                onClick={() => revokePrivateAccess.mutate(session.data.privateAccess!.grantId, {
                  onSuccess: () => onDone?.(),
                })}
                type="button"
              >
                {revokePrivateAccess.isPending ? 'Stopping…' : 'Stop private access'}
              </button>
            ) : null}
            {resumed && canDrive ? (
              <button className="admin-button admin-button-primary admin-button-compact" disabled={endResumed.isPending} onClick={() => endResumed.mutate(sessionId, { onSuccess: onDone })} type="button">
                {endResumed.isPending ? 'Saving…' : 'Done'}
              </button>
            ) : session.data?.canControl ? (
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                disabled={control.pending || heldByAnotherPerson}
                onClick={() => {
                  if (canDrive) control.handBack()
                  else if (viewerHasLiveLease && control.controlling) {
                    inputEpoch.current += 1
                    setInputStopped(false)
                    setCanvasRetry((attempt) => attempt + 1)
                  }
                  else {
                    inputEpoch.current += 1
                    setInputStopped(false)
                    control.take()
                  }
                }}
                type="button"
              >
                {canDrive ? 'Hand back' : viewerHasLiveLease && control.controlling ? 'Reconnect' : 'Take control'}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className={variant === 'panel'
        ? 'relative mx-3 mb-3 aspect-[16/10] flex-none overflow-hidden bg-[color:var(--bg2)]'
        : 'relative min-h-0 flex-1 overflow-hidden bg-[color:var(--bg2)]'}>
        {screenshotUrl ? (
          <div
            aria-label={`${session.data?.agentName ?? 'Agent'} browser`}
            className={canDrive ? 'h-full w-full touch-none cursor-default' : 'h-full w-full'}
            onClick={canDrive ? onCanvasClick : undefined}
            onPointerCancel={canDrive ? onCanvasPointerEnd : undefined}
            onPointerDown={canDrive ? onCanvasPointerDown : undefined}
            onPointerMove={canDrive ? onCanvasPointerMove : undefined}
            onPointerUp={canDrive ? onCanvasPointerEnd : undefined}
            onWheel={canDrive ? onCanvasWheel : undefined}
            role={canDrive ? 'application' : 'img'}
            tabIndex={canDrive ? 0 : undefined}
          >
            <img alt="Current remote browser screen" className="h-full w-full select-none object-contain" draggable={false} src={screenshotUrl} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[color:var(--tx2)]">{emptyState}</div>
        )}
        {screenshotUrl ? (
          <BrowserPreviewStatus
            countdown={countdown?.warning ? { expired: countdown.expired, secondsLeft: countdown.secondsLeft } : null}
            disclosure=""
            onContinue={() => keepAlive.mutate()}
            pending={keepAlive.isPending}
            status={previewStatus}
            variant={variant}
          />
        ) : null}
        <textarea
          aria-label="Browser keyboard"
          className="absolute bottom-0 left-0 h-px w-px resize-none border-0 bg-transparent p-0 opacity-0"
          disabled={!canDrive}
          onChange={onTextChange}
          onKeyDown={onKeyboard}
          ref={keyboard}
          value={typedText}
        />
      </div>
      {variant === 'fullscreen' ? (
        <p className="flex-shrink-0 px-4 py-2 text-xs text-[color:var(--tx3)]">
          {claimFailed
            ? 'Couldn’t take control — try Take control above.'
            : inputStopped && viewerHasLiveLease
              ? 'The control connection stopped before the browser accepted that input. Reconnect to continue.'
              : inputStopped
                ? 'Control expired before the browser accepted that input. Take control to continue.'
              : session.data?.canControl === false
                ? 'You can watch this browser, but only its private owner can take control.'
              : canDrive
              ? 'Your keystrokes are not recorded in chat. After Done, the agent can read pages it has access to.'
              : 'Live preview. Take control to use the browser.'}
        </p>
      ) : null}
    </div>
  )
}
