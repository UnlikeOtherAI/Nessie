// One `/api/activity` WebSocket per signed-in tab, fanned out in the client.
//
// The socket is scoped: a subscriber says which organisation, channels and
// dashboards it cares about and the connection sends the union. The shell and
// the dashboard registry each used to open one of their own, so a tab held two
// authenticated sockets that pinged, backed off and invalidated the same query
// keys twice over — and a re-subscription on either one replayed a snapshot the
// other had already applied.
//
// Kept apart from `realtime.ts` so the connection's own questions — "do two
// subscribers share a socket?", "does a scope change re-send once?" — are
// answerable with a stub socket, no React and no query client.

import { WsServerMessageSchema } from '@nessie/schemas'
import {
  resolveWebSocketUrl,
  type RealtimeConnectionState,
  type WsServerMessage,
} from './realtime-snapshot'

export type ActivityScope = {
  channelIds: string[]
  dashboardIds: string[]
  organizationId: string
}

export type ActivitySubscriber = {
  onMessage: (message: WsServerMessage) => void
  onState: (state: RealtimeConnectionState) => void
  scope: ActivityScope
}

/** One scope entry of a `set_subscriptions` frame. */
type ActivityScopeFrame =
  | { channelId: string; kind: 'channel' }
  | { dashboardId: string; kind: 'dashboard' }
  | { kind: 'organization'; organizationId: string }

export type ActivitySubscription = {
  setScope: (scope: ActivityScope) => void
  unsubscribe: () => void
}

const BACKOFF_SCHEDULE = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
const HANDSHAKE_TIMEOUT_MS = 10_000
const PING_INTERVAL_MS = 30_000
// A scope change is a re-subscription, and mounting a screen moves several
// subscribers within the same frame. Coalescing them keeps one route change
// from becoming a burst of `set_subscriptions` frames.
const RESUBSCRIBE_DEBOUNCE_MS = 50

/**
 * The union every subscriber's scope adds up to, in a stable order so an
 * unchanged set of scopes serialises to an unchanged frame.
 */
export const unionActivityScopes = (scopes: ActivityScope[]): ActivityScopeFrame[] => {
  const organizationIds = new Set<string>()
  const channelIds = new Set<string>()
  const dashboardIds = new Set<string>()
  for (const scope of scopes) {
    if (scope.organizationId) organizationIds.add(scope.organizationId)
    for (const channelId of scope.channelIds) if (channelId) channelIds.add(channelId)
    for (const dashboardId of scope.dashboardIds) if (dashboardId) dashboardIds.add(dashboardId)
  }
  const sorted = (values: Set<string>): string[] => [...values].sort()
  return [
    ...sorted(organizationIds).map((organizationId) => ({
      kind: 'organization' as const,
      organizationId,
    })),
    ...sorted(channelIds).map((channelId) => ({ channelId, kind: 'channel' as const })),
    ...sorted(dashboardIds).map((dashboardId) => ({ dashboardId, kind: 'dashboard' as const })),
  ]
}

const subscribers = new Set<ActivitySubscriber>()

let socket: WebSocket | null = null
let activeToken: string | null = null
let connectionState: RealtimeConnectionState = 'disconnected'
let reconnectAttempts = 0
type Timer = ReturnType<typeof setTimeout>

let reconnectTimer: Timer | undefined
let handshakeTimer: Timer | undefined
let resubscribeTimer: Timer | undefined
let pingInterval: ReturnType<typeof setInterval> | undefined
let sentSubscriptions = ''

const clearTimer = (timer: Timer | undefined): undefined => {
  if (timer !== undefined) clearTimeout(timer)
  return undefined
}

const publishState = (next: RealtimeConnectionState): void => {
  connectionState = next
  for (const subscriber of subscribers) subscriber.onState(next)
}

const currentSubscriptionFrame = (): string =>
  JSON.stringify({
    scopes: unionActivityScopes([...subscribers].map((subscriber) => subscriber.scope)),
    type: 'set_subscriptions',
  })

const sendSubscriptions = (): void => {
  if (socket?.readyState !== WebSocket.OPEN) return
  const frame = currentSubscriptionFrame()
  if (frame === sentSubscriptions) return
  sentSubscriptions = frame
  socket.send(frame)
}

const scheduleResubscribe = (): void => {
  if (resubscribeTimer !== undefined) return
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = undefined
    sendSubscriptions()
  }, RESUBSCRIBE_DEBOUNCE_MS)
}

const teardown = (): void => {
  reconnectTimer = clearTimer(reconnectTimer)
  handshakeTimer = clearTimer(handshakeTimer)
  resubscribeTimer = clearTimer(resubscribeTimer)
  if (pingInterval !== undefined) {
    clearInterval(pingInterval)
    pingInterval = undefined
  }
  const closing = socket
  socket = null
  sentSubscriptions = ''
  closing?.close()
}

const scheduleReconnect = (): void => {
  if (subscribers.size === 0 || reconnectTimer !== undefined) return
  const delay = BACKOFF_SCHEDULE[Math.min(reconnectAttempts, BACKOFF_SCHEDULE.length - 1)]
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    connect()
  }, delay)
}

function connect(): void {
  const token = activeToken
  if (!token || subscribers.size === 0) return
  // A still-connecting socket is forcibly torn down so we don't wait out the
  // browser's multi-minute handshake timeout.
  if (socket && socket.readyState === WebSocket.CONNECTING) {
    socket.close()
    socket = null
  }
  reconnectTimer = clearTimer(reconnectTimer)
  handshakeTimer = clearTimer(handshakeTimer)
  if (pingInterval !== undefined) {
    clearInterval(pingInterval)
    pingInterval = undefined
  }
  sentSubscriptions = ''
  publishState('connecting')

  const opened = new WebSocket(resolveWebSocketUrl(token))
  socket = opened

  // Force teardown if the handshake never completes — otherwise a stuck
  // CONNECTING socket can pin us for the browser default (~minutes).
  handshakeTimer = setTimeout(() => {
    handshakeTimer = undefined
    if (opened.readyState !== WebSocket.OPEN) opened.close()
  }, HANDSHAKE_TIMEOUT_MS)

  opened.addEventListener('open', () => {
    if (socket !== opened) {
      opened.close()
      return
    }
    sendSubscriptions()
    // 30-second keepalive ping to survive Cloud Run connection cycling
    pingInterval = setInterval(() => {
      if (opened.readyState === WebSocket.OPEN) opened.send(JSON.stringify({ type: 'ping' }))
    }, PING_INTERVAL_MS)
  })

  opened.addEventListener('message', (event) => {
    const parsed = WsServerMessageSchema.safeParse(
      JSON.parse((event as MessageEvent).data as string),
    )
    if (!parsed.success) return
    if (parsed.data.type === 'subscribed') {
      // Server-acknowledged handshake — safe to reset backoff.
      reconnectAttempts = 0
      handshakeTimer = clearTimer(handshakeTimer)
      publishState('connected')
    }
    for (const subscriber of subscribers) subscriber.onMessage(parsed.data)
  })

  opened.addEventListener('close', () => {
    if (socket !== opened) return
    if (pingInterval !== undefined) {
      clearInterval(pingInterval)
      pingInterval = undefined
    }
    handshakeTimer = clearTimer(handshakeTimer)
    socket = null
    sentSubscriptions = ''
    publishState('disconnected')
    scheduleReconnect()
  })

  opened.addEventListener('error', () => opened.close())
}

/**
 * Attach to the shared activity socket.
 *
 * The first subscriber opens the connection and the last one to leave closes
 * it; a rotated token reopens it, because the bearer travels in the URL. A
 * subscriber narrows or widens its own scope through `setScope`, which re-sends
 * the union once the burst it arrived in has settled.
 */
export const subscribeAgentActivity = (
  token: string,
  subscriber: ActivitySubscriber,
): ActivitySubscription => {
  const registration: ActivitySubscriber = { ...subscriber }
  subscribers.add(registration)

  if (activeToken !== token) {
    activeToken = token
    reconnectAttempts = 0
    teardown()
    connect()
  } else if (socket === null && reconnectTimer === undefined) {
    connect()
  } else {
    registration.onState(connectionState)
    scheduleResubscribe()
  }

  return {
    setScope: (scope) => {
      registration.scope = scope
      scheduleResubscribe()
    },
    unsubscribe: () => {
      subscribers.delete(registration)
      if (subscribers.size === 0) {
        activeToken = null
        reconnectAttempts = 0
        connectionState = 'disconnected'
        teardown()
        return
      }
      scheduleResubscribe()
    },
  }
}
