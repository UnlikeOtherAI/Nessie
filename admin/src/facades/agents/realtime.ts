import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentStatusResponse } from '@nessie/schemas'
import { WsServerMessageSchema } from '@nessie/schemas'
import type { AgentRecord } from '../../lib/api-client'
import {
  agentCardKeys,
  agentKeys,
  agentTodoKeys,
  approvalKeys,
  channelKeys,
  dashboardKeys,
  threadKeys,
} from '../../lib/query-keys'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  mergeAgentSnapshot,
  patchAgentStatusRecord,
  resolveWebSocketUrl,
  snapshotToRecords,
  type AgentActivityRealtimeState,
  type AgentRealtimeRecord,
  type RealtimeConnectionState,
  type WsServerMessage,
} from './keys'

export const useAgentRealtime = (input: {
  channelId?: string
  channelIds?: string[]
  dashboardIds?: string[]
  organizationId?: string
  threadId?: string
}): AgentActivityRealtimeState => {
  const queryClient = useQueryClient()
  const { me, token } = useAuthSession()
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>('disconnected')
  const [records, setRecords] = useState<Record<string, AgentRealtimeRecord>>({})
  const threadIdRef = useRef(input.threadId)
  threadIdRef.current = input.threadId
  const subscriptionChannelIds = useMemo(
    () =>
      Array.from(
        new Set(
          [input.channelId, ...(input.channelIds ?? [])].filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          ),
        ),
      ),
    [input.channelId, input.channelIds],
  )
  const subscriptionKey = subscriptionChannelIds.slice().sort().join(',')
  const subscriptionDashboardIds = useMemo(
    () => Array.from(new Set((input.dashboardIds ?? []).filter((id) => id.length > 0))).sort(),
    [input.dashboardIds],
  )
  const dashboardSubscriptionKey = subscriptionDashboardIds.join(',')

  useEffect(() => {
    if (!token || !me?.context.organizationId) {
      setConnectionState('disconnected')
      setRecords({})
      return
    }

    let closed = false
    let reconnectTimer: number | undefined
    let handshakeTimer: number | undefined
    let socket: WebSocket | null = null
    let reconnectAttempts = 0
    const backoffSchedule = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
    const HANDSHAKE_TIMEOUT_MS = 10_000

    const clearReconnectTimer = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
    }

    const clearHandshakeTimer = () => {
      if (handshakeTimer !== undefined) {
        window.clearTimeout(handshakeTimer)
        handshakeTimer = undefined
      }
    }

    const scheduleReconnect = () => {
      if (closed || reconnectTimer !== undefined) {
        return
      }
      const delay =
        backoffSchedule[Math.min(reconnectAttempts, backoffSchedule.length - 1)]
      reconnectAttempts += 1
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, delay)
    }

    const invalidateAgentCaches = (agentId: string) => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.activity(agentId) })
      void queryClient.invalidateQueries({ queryKey: agentKeys.children(agentId) })
      void queryClient.invalidateQueries({ queryKey: agentKeys.messages(agentId) })
      void queryClient.invalidateQueries({ queryKey: agentKeys.status(agentId) })
    }

    const handleServerMessage = (message: WsServerMessage) => {
      if (message.type === 'subscribed') {
        // Server-acknowledged handshake — safe to reset backoff.
        reconnectAttempts = 0
        clearHandshakeTimer()
        setConnectionState('connected')
        setRecords(snapshotToRecords(message.snapshot))
        queryClient.setQueryData<AgentRecord[] | undefined>(
          agentKeys.all,
          (current) => mergeAgentSnapshot(current, message.snapshot),
        )
        // Dashboard events are advisory invalidations rather than a replay log.
        // A successful re-subscription is therefore the resync boundary after a
        // dropped socket: fetch the authoritative, ACL-checked state before a
        // compact card or workspace can keep an out-of-date revision.
        const resyncDashboardIds = dashboardSubscriptionKey
          .split(',')
          .filter((dashboardId) => dashboardId.length > 0)
        for (const dashboardId of resyncDashboardIds) {
          void queryClient.invalidateQueries({ queryKey: dashboardKeys.detail(dashboardId) })
        }
        if (resyncDashboardIds.length > 0) {
          void queryClient.invalidateQueries({ queryKey: dashboardKeys.widgetDataAll })
        }
        return
      }

      if (message.type !== 'event') {
        return
      }

      if (message.event === 'agent.status') {
        setRecords((current) => ({
          ...current,
          [message.data.agentId]: {
            currentRunId: message.data.currentRunId,
            currentToolName: message.data.currentToolName,
            currentToolStartedAt: message.data.currentToolStartedAt,
            since: message.data.since,
            status: message.data.status,
          },
        }))
        queryClient.setQueryData<AgentRecord[] | undefined>(
          agentKeys.all,
          (current) =>
            patchAgentStatusRecord(current, {
              agentId: message.data.agentId,
              currentRunId: message.data.currentRunId,
              currentToolName: message.data.currentToolName,
              currentToolStartedAt: message.data.currentToolStartedAt,
              status: message.data.status,
              ts: message.ts,
            }),
        )
        queryClient.setQueryData<AgentStatusResponse | undefined>(
          agentKeys.status(message.data.agentId),
          (current) =>
            current
              ? {
                  ...current,
                  currentRunId: message.data.currentRunId,
                  currentToolName: message.data.currentToolName,
                  currentToolStartedAt: message.data.currentToolStartedAt,
                  since: message.data.since,
                  status: message.data.status,
                }
              : current,
        )
        return
      }

      if (message.event === 'agent.tool.start' || message.event === 'agent.tool.end') {
        invalidateAgentCaches(message.data.agentId)
        return
      }

      if (message.event === 'agent.spawned') {
        invalidateAgentCaches(message.data.parentId)
        void queryClient.invalidateQueries({ queryKey: agentKeys.all })
        return
      }

      if (message.event === 'run.updated') {
        invalidateAgentCaches(message.data.agentId)
        return
      }

      if (message.event === 'agent.todo.updated') {
        // The event carries no title, step, or note. A to-do card can therefore
        // only repaint after its regular entitled API read succeeds.
        void queryClient.invalidateQueries({
          queryKey: agentTodoKeys.instances(message.data.agentId),
        })
        void queryClient.invalidateQueries({
          queryKey: agentTodoKeys.card(message.data.todoId),
        })
        return
      }

      if (message.event === 'message.new') {
        if (message.data.agentId) {
          invalidateAgentCaches(message.data.agentId)
        }
        void queryClient.invalidateQueries({ queryKey: channelKeys.all })
        if (message.data.threadId === threadIdRef.current) {
          void queryClient.invalidateQueries({
            queryKey: threadKeys.messages(message.data.threadId),
          })
        }
        return
      }

      if (message.event === 'dashboard.updated') {
        // The event deliberately contains only an id and monotonic revision.
        // Refetching is the ACL check and rejects stale/out-of-order payloads.
        void queryClient.invalidateQueries({ queryKey: dashboardKeys.detail(message.data.dashboardId) })
        void queryClient.invalidateQueries({ queryKey: dashboardKeys.widgetDataAll })
        return
      }

      // A card reached a terminal state. Only the card's own query is invalidated:
      // the press also wrote a reply, which refreshes the thread through
      // `message.reply` like any other message.
      if (message.event === 'card.updated') {
        void queryClient.invalidateQueries({
          queryKey: agentCardKeys.card(message.data.cardId),
        })
        return
      }

      if (message.event === 'approval.needed' || message.event === 'approval.resolved') {
        // Both the sidebar badge and an in-thread card are entitlement-scoped
        // reads. WS carries ids only, so cache invalidation preserves that
        // server decision instead of projecting approval content into a room.
        void queryClient.invalidateQueries({ queryKey: approvalKeys.all })
        return
      }

      // A message changed in place — today the rolling watch status line.
      // Deliberately refreshes only the open thread and NOT channelKeys.all: an
      // edit is not new activity, so channel badges and unread counts must
      // stay exactly where they were.
      if (message.event === 'message.updated') {
        if (message.data.threadId === threadIdRef.current) {
          void queryClient.invalidateQueries({
            queryKey: threadKeys.messages(message.data.threadId),
          })
        }
        return
      }

      // Reply threads (#233): a new reply or updated root summary refreshes
      // both the top-level feed (summary bars) and any open reply panel.
      if (message.event === 'message.reply' || message.event === 'message.reply.meta') {
        // This listener owns cache coherence independently of notification
        // preference. A muted user still needs their sidebar/app badge to move.
        if (message.event === 'message.reply') {
          void queryClient.invalidateQueries({ queryKey: channelKeys.all })
        }
        void queryClient.invalidateQueries({
          queryKey: threadKeys.messages(message.data.threadId),
        })
        void queryClient.invalidateQueries({
          queryKey: threadKeys.repliesOf(message.data.threadId, message.data.rootMessageId),
        })
        return
      }
    }

    let pingInterval: number | undefined

    const clearPingInterval = () => {
      if (pingInterval !== undefined) {
        window.clearInterval(pingInterval)
        pingInterval = undefined
      }
    }

    const connect = () => {
      if (closed) {
        return
      }
      // A still-connecting socket is forcibly torn down so we don't wait
      // out the browser's multi-minute handshake timeout.
      if (socket && socket.readyState === WebSocket.CONNECTING) {
        socket.close()
        socket = null
      }
      clearReconnectTimer()
      clearHandshakeTimer()
      clearPingInterval()
      setConnectionState('connecting')

      socket = new WebSocket(resolveWebSocketUrl(token))

      // Force teardown if the handshake never completes — otherwise a stuck
      // CONNECTING socket can pin us for the browser default (~minutes).
      handshakeTimer = window.setTimeout(() => {
        handshakeTimer = undefined
        if (socket && socket.readyState !== WebSocket.OPEN) {
          socket.close()
        }
      }, HANDSHAKE_TIMEOUT_MS)

      socket.addEventListener('open', () => {
        if (closed) {
          socket?.close()
          return
        }
        const channelScopes = subscriptionKey
          .split(',')
          .filter((channelId) => channelId.length > 0)
          .map((channelId) => ({
            kind: 'channel' as const,
            channelId,
          }))
        const dashboardScopes = dashboardSubscriptionKey
          .split(',')
          .filter((dashboardId) => dashboardId.length > 0)
          .map((dashboardId) => ({ kind: 'dashboard' as const, dashboardId }))
        socket?.send(
          JSON.stringify({
            type: 'set_subscriptions',
            scopes: [
              {
                kind: 'organization',
                organizationId: me.context.organizationId,
              },
              ...channelScopes,
              ...dashboardScopes,
            ],
          }),
        )

        // 30-second keepalive ping to survive Cloud Run connection cycling
        pingInterval = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }))
          }
        }, 30_000)
      })

      socket.addEventListener('message', (event) => {
        const parsed = WsServerMessageSchema.safeParse(JSON.parse(event.data as string))
        if (!parsed.success) {
          return
        }

        handleServerMessage(parsed.data)
      })

      socket.addEventListener('close', () => {
        clearPingInterval()
        clearHandshakeTimer()
        if (closed) {
          return
        }

        setConnectionState('disconnected')
        scheduleReconnect()
      })

      socket.addEventListener('error', () => {
        socket?.close()
      })
    }

    connect()

    return () => {
      closed = true
      clearReconnectTimer()
      clearHandshakeTimer()
      clearPingInterval()
      socket?.close()
    }
  }, [dashboardSubscriptionKey, me?.context.organizationId, queryClient, subscriptionKey, token])

  return {
    connectionState,
    records,
  }
}
