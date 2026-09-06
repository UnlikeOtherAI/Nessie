import {
  parseLastRealtimeEventId,
  type RealtimeNotificationPayload,
  type RealtimeReplayEvent,
  type WsEventMessage,
} from '@nessie/runtime'
import type { WsScope } from '@nessie/schemas'
import {
  createEntitlementGate,
  type RealtimeDeliveryEntitlements,
} from './delivery-entitlements.js'

/**
 * The subset of a Node `ServerResponse` an SSE connection writes through. Named
 * structurally rather than imported: nothing here hosts or dials HTTP, and the
 * api tree bans `node:http` so a request client cannot slip past the egress
 * boundary under cover of a response type.
 */
type SseResponseSink = {
  once: (event: 'drain', listener: () => void) => unknown
  write: (chunk: string) => boolean
  /**
   * A drain ends the stream itself (see `endSseConnectionForShutdown`). Both
   * members are optional because only a real `ServerResponse` — which every
   * production connection is — carries them; a test double that registers a
   * connection to observe delivery is never drained.
   */
  end?: () => unknown
  writableEnded?: boolean
}

/**
 * Connection bookkeeping and the LISTEN-side fan-out, split out of `hub.ts` so
 * neither file breaches the 500-line cap (AGENTS.md). `hub.ts` owns the
 * transport, the pool and the connect/hydrate lifecycle; this file owns who a
 * given notification is allowed to reach.
 */

export type ThreadSseConnection = {
  kind: 'thread'
  lastSequence: number
  pending: Extract<RealtimeNotificationPayload, { kind: 'sse' }>[]
  response: SseResponseSink
  hydrating: boolean
  // True while the socket's write buffer is backed up. Ephemeral events are
  // dropped for the duration instead of queued: they carry no sequence, so
  // memory spent holding them buys nothing a re-bootstrap does not.
  saturated: boolean
  threadId: string
  /**
   * The person the stream belongs to, so the channel behind the thread can be
   * re-authorized on every event the way the ws/user-sse branches already
   * re-authorize theirs. Null when the route registered the connection by
   * thread id alone, in which case no recheck is possible for it.
   */
  viewer: { organizationId: string; userId: string } | null
  /** Resolved once — a thread does not change channels. */
  channelId: string | null
}

export type AddThreadSseConnectionInput = {
  kind: 'thread'
  organizationId: string
  threadId: string
  userId: string
}

export type UserSseConnection = {
  kind: 'user'
  channelIds: Set<string>
  hydrating: boolean
  lastEventId: bigint
  organizationId: string
  pending: RealtimeReplayEvent[]
  response: SseResponseSink
  scopes: WsScope[]
  userId: string
}

export type SseConnection = ThreadSseConnection | UserSseConnection

export type WsConnection = {
  // Closing the socket is the route's business — the hub only tracks the
  // connection — but a drain has to reach the socket itself, so the registrant
  // hands over a closer alongside the sender.
  close: (code: number, reason: string) => void
  organizationId: string
  scopes: WsScope[]
  send: (message: WsEventMessage) => void
  userId: string
}

export type AddUserSseConnectionInput = {
  kind: 'user'
  channelIds: string[]
  organizationId: string
  scopes: WsScope[]
  userId: string
}

export const formatSseEvent = (notification: Extract<RealtimeNotificationPayload, { kind: 'sse' }>) => {
  // An ephemeral notification has no `thread_stream_events` row, so its
  // `sequence` is a placeholder: writing it as `id:` would rewind the client's
  // Last-Event-ID and make the next reconnect replay from the wrong point.
  const idLine = notification.ephemeral ? '' : `id: ${notification.sequence}\n`
  return `${idLine}event: ${notification.event}\ndata: ${JSON.stringify(notification.data)}\n\n`
}

// Per-connection backpressure. A slow reader must never grow an unbounded
// in-process buffer, so once the socket reports a full write buffer every
// ephemeral event is dropped for that connection until it drains; the client
// sees a `seq` gap and re-bootstraps over REST. Durable events keep Node's
// own buffering, which the replay watermark already makes recoverable.
const writeThreadSseEvent = (
  connection: ThreadSseConnection,
  notification: Extract<RealtimeNotificationPayload, { kind: 'sse' }>,
): void => {
  if (notification.ephemeral && connection.saturated) {
    return
  }

  if (!connection.response.write(formatSseEvent(notification)) && !connection.saturated) {
    connection.saturated = true
    connection.response.once('drain', () => {
      connection.saturated = false
    })
  }
}

export const formatUserSseEvent = (event: RealtimeReplayEvent) =>
  `id: ${event.id.toString()}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`

// The last frame a draining replica writes to an SSE stream. `retry:` resets
// the EventSource reconnection time to 2 s for any native-EventSource client;
// the admin runs its own fetch-based loop (`admin/src/lib/sse.ts` drops the
// field) and reconnects on its own base backoff, so the line costs nothing
// there and is the whole signal for a client that does use EventSource. No
// `id:` — this frame is not a replayable event and must not move the
// client's Last-Event-ID watermark.
const SHUTDOWN_SSE_FRAME = 'retry: 2000\nevent: shutdown\ndata: {}\n\n'

// Fastify 5.8.4 leaves `forceCloseConnections` at `'idle'` — verified in
// `node_modules/fastify/lib/server.js:131-137`, where a non-boolean option
// becomes `'idle'` on any Node that exposes `server.closeIdleConnections()`.
// `'idle'` closes only *idle* sockets, and an open SSE stream is an in-flight
// request, so `app.close()` on its own waits for every live stream and the
// drain never finishes. The hub therefore ends its own streams before the
// server closes — it owns the registries, so the terminator lives here with
// them and `hub.ts` calls it from `closeLiveConnections`.
export const endSseConnectionForShutdown = (response: SseResponseSink): void => {
  try {
    if (response.writableEnded) {
      return
    }

    response.write(SHUTDOWN_SSE_FRAME)
    response.end?.()
  } catch {
    // The peer already went away; nothing left to drain on this socket.
  }
}

const toScopeKey = (scope: WsScope): string => JSON.stringify(scope)

export const shouldDeliverWsNotification = async (
  input: {
    canAccessAgent: (agentId: string) => Promise<boolean>
    canAccessChannel: (channelId: string) => Promise<boolean>
    canAccessDashboard?: (dashboardId: string) => Promise<boolean>
    canAccessOrganization: (organizationId: string) => Promise<boolean>
    connectionScopes: WsScope[]
    notificationScopes: WsScope[]
  },
): Promise<boolean> => {
  const notificationChannelScopes = input.notificationScopes.filter(
    (scope): scope is Extract<WsScope, { kind: 'channel' }> => scope.kind === 'channel',
  )
  const notificationUserScopes = input.notificationScopes.filter(
    (scope): scope is Extract<WsScope, { kind: 'user' }> => scope.kind === 'user',
  )
  const notificationDashboardScopes = input.notificationScopes.filter(
    (scope): scope is Extract<WsScope, { kind: 'dashboard' }> => scope.kind === 'dashboard',
  )
  if (notificationUserScopes.length > 0) {
    return input.connectionScopes.some((scope) =>
      scope.kind === 'user' && notificationUserScopes.some((target) =>
        target.userId === scope.userId && target.organizationId === scope.organizationId,
      ),
    )
  }
  const notificationScopeKeys = new Set(input.notificationScopes.map(toScopeKey))

  if (notificationChannelScopes.length > 0) {
    if (!input.connectionScopes.some((scope) => notificationScopeKeys.has(toScopeKey(scope)))) {
      return false
    }

    for (const scope of notificationChannelScopes) {
      if (!(await input.canAccessChannel(scope.channelId))) {
        return false
      }
    }
    return true
  }

  if (notificationDashboardScopes.length > 0) {
    if (!input.connectionScopes.some((scope) => notificationScopeKeys.has(toScopeKey(scope)))) {
      return false
    }
    for (const scope of notificationDashboardScopes) {
      if (!input.canAccessDashboard || !(await input.canAccessDashboard(scope.dashboardId))) {
        return false
      }
    }
    return true
  }

  if (!input.connectionScopes.some((scope) => notificationScopeKeys.has(toScopeKey(scope)))) {
    return false
  }

  // Organization and agent scopes were authorized at subscribe time and never
  // again, so a deactivated member kept the org feed and a person who lost
  // sight of an agent kept its updates for as long as the socket stayed open.
  // Both are now re-asked here, the same shape the channel branch above pays.
  for (const scope of input.notificationScopes) {
    if (scope.kind === 'organization' && !(await input.canAccessOrganization(scope.organizationId))) {
      return false
    }
    if (scope.kind === 'agent' && !(await input.canAccessAgent(scope.agentId))) {
      return false
    }
  }

  return true
}

/**
 * The LISTEN-side fan-out, exported so it can be exercised without a live
 * pg LISTEN connection. It never writes to `realtime_events`: the publisher
 * persisted the row before NOTIFYing (`PgRealtimeTransport.publishWs`), so
 * with N api replicas listening, N appends here would corrupt the shared
 * Last-Event-ID sequence. A notification carrying no `eventId` comes from an
 * older publisher mid rolling deploy and is fanned out live with no replay
 * bookkeeping.
 */
export const createWsNotificationDelivery = (input: {
  canAccessChannelEvent?: (input: {
    channelId: string
    organizationId: string
    userId: string
  }) => Promise<boolean>
  canAccessDashboardEvent?: (input: {
    dashboardId: string
    organizationId: string
    userId: string
  }) => Promise<boolean>
  entitlements?: Partial<RealtimeDeliveryEntitlements>
  /** Clock behind the per-connection entitlement cache's TTL. */
  now?: () => number
}) => {
  const threadSseConnections = new Set<ThreadSseConnection>()
  const userSseConnections = new Set<UserSseConnection>()
  const wsConnections = new Set<WsConnection>()

  // One gate per connection: the cache is keyed inside the closure, so it dies
  // with the connection and can never outlive the entitlement it caches.
  const connectionGates = new WeakMap<
    object,
    {
      agent: (agentId: string) => Promise<boolean>
      channel: (channelId: string) => Promise<boolean>
      organization: (organizationId: string) => Promise<boolean>
    }
  >()

  const gatesFor = (
    connection: object,
    identity: { organizationId: string; userId: string },
  ) => {
    const existing = connectionGates.get(connection)
    if (existing) return existing
    const clock = input.now ? { now: input.now } : {}
    const gates = {
      agent: createEntitlementGate(
        async (agentId: string) =>
          input.entitlements?.canAccessAgentEvent
            ? input.entitlements.canAccessAgentEvent({ agentId, ...identity })
            : true,
        clock,
      ),
      channel: createEntitlementGate(
        async (channelId: string) =>
          input.canAccessChannelEvent
            ? input.canAccessChannelEvent({ channelId, ...identity })
            : true,
        clock,
      ),
      organization: createEntitlementGate(
        async (organizationId: string) =>
          input.entitlements?.canAccessOrganizationEvent
            ? input.entitlements.canAccessOrganizationEvent({
                organizationId,
                userId: identity.userId,
              })
            : true,
        clock,
      ),
    }
    connectionGates.set(connection, gates)
    return gates
  }

  /**
   * A thread stream is bound to one channel, and the person's access to that
   * channel can be revoked mid-stream. This asks the same question the ws and
   * user-sse branches ask, through a short-TTL gate so a token-by-token
   * `stream.delta` burst costs one query rather than one per token.
   */
  const threadConnectionStillEntitled = async (
    connection: ThreadSseConnection,
  ): Promise<boolean> => {
    const viewer = connection.viewer
    if (!viewer) return true
    if (connection.channelId === null) {
      connection.channelId =
        (await input.entitlements?.resolveThreadChannelId?.(connection.threadId)) ?? null
      if (connection.channelId === null) return false
    }
    return gatesFor(connection, viewer).channel(connection.channelId)
  }

  const deliverNotification = async (notification: RealtimeNotificationPayload) => {
    if (notification.kind === 'sse') {
      const ephemeral = notification.ephemeral === true
      for (const connection of threadSseConnections) {
        if (connection.threadId !== notification.threadId) {
          continue
        }
        if (!(await threadConnectionStillEntitled(connection))) {
          continue
        }
        // Sequence filtering and the watermark only apply to durable events;
        // an ephemeral notification's sequence is a placeholder.
        if (!ephemeral && connection.lastSequence >= notification.sequence) {
          continue
        }

        if (connection.hydrating) {
          // The pending buffer is sequence-sorted, so an ephemeral event has no
          // place in it and is dropped — the bootstrap the client runs after
          // connecting covers the gap by construction.
          if (!ephemeral) {
            connection.pending.push(notification)
          }
          continue
        }

        writeThreadSseEvent(connection, notification)
        if (!ephemeral) {
          connection.lastSequence = notification.sequence
        }
      }
      return
    }

    // The publisher persisted the row before NOTIFYing and carried its id in
    // the payload; a listener must never append — with N api replicas that
    // wrote N copies of the same event and duplicated every replay.
    // During a rolling deploy an old publisher still sends payloads without
    // an id: those are fanned out live only, with no replay bookkeeping, so
    // the mixed-version window can miss a row from replay but never writes a
    // duplicate.
    const replayEventId =
      typeof notification.eventId === 'string'
        ? parseLastRealtimeEventId(notification.eventId)
        : null
    const replayEvent: RealtimeReplayEvent | null =
      replayEventId !== null && replayEventId > 0n
        ? {
            id: replayEventId,
            channelId: null,
            createdAt: new Date(notification.message.ts),
            eventType: notification.message.event,
            payload: notification.message,
            recipientUserId: null,
          }
        : null

    if (replayEvent) {
      for (const connection of userSseConnections) {
        if (connection.lastEventId >= replayEvent.id) {
          continue
        }

        const gates = gatesFor(connection, {
          organizationId: connection.organizationId,
          userId: connection.userId,
        })
        const shouldDeliver = await shouldDeliverWsNotification({
          connectionScopes: connection.scopes,
          notificationScopes: notification.scopes,
          canAccessAgent: gates.agent,
          canAccessOrganization: gates.organization,
          canAccessChannel: async (channelId) =>
            input.canAccessChannelEvent
              ? input.canAccessChannelEvent({
                  channelId,
                  organizationId: connection.organizationId,
                  userId: connection.userId,
                })
              : connection.channelIds.has(channelId),
          canAccessDashboard: async (dashboardId) =>
            input.canAccessDashboardEvent
              ? input.canAccessDashboardEvent({
                  dashboardId,
                  organizationId: connection.organizationId,
                  userId: connection.userId,
                })
              : false,
        })

        if (!shouldDeliver) {
          continue
        }

        if (connection.hydrating) {
          connection.pending.push(replayEvent)
          continue
        }

        connection.response.write(formatUserSseEvent(replayEvent))
        connection.lastEventId = replayEvent.id
      }
    }

    for (const connection of wsConnections) {
      const gates = gatesFor(connection, {
        organizationId: connection.organizationId,
        userId: connection.userId,
      })
      const shouldDeliver = await shouldDeliverWsNotification({
        connectionScopes: connection.scopes,
        notificationScopes: notification.scopes,
        canAccessAgent: gates.agent,
        canAccessOrganization: gates.organization,
        canAccessChannel: async (channelId) =>
          input.canAccessChannelEvent
            ? input.canAccessChannelEvent({
                channelId,
                organizationId: connection.organizationId,
                userId: connection.userId,
              })
            : connection.scopes.some(
                (scope) => scope.kind === 'channel' && scope.channelId === channelId,
              ),
        canAccessDashboard: async (dashboardId) =>
          input.canAccessDashboardEvent
            ? input.canAccessDashboardEvent({
                dashboardId,
                organizationId: connection.organizationId,
                userId: connection.userId,
              })
            : false,
      })

      if (!shouldDeliver) {
        continue
      }

      connection.send(notification.message)
    }
  }

  return {
    deliverNotification,
    threadSseConnections,
    userSseConnections,
    wsConnections,
  }
}
