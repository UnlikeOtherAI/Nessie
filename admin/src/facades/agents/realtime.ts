import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentStatusResponse } from '@nessie/schemas'
import type { AgentRecord } from '../../lib/api-client'
import { agentCardKeys } from '../agent-cards/keys'
import { agentTodoKeys } from '../agent-todos/keys'
import { approvalKeys } from '../approvals/keys'
import { channelKeys } from '../channels/keys'
import { dashboardKeys } from '../dashboards/keys'
import { projectKeys } from '../projects/keys'
import { taskKeys } from '../tasks/keys'
import { threadKeys } from '../threads/keys'
import { agentKeys } from './keys'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  subscribeAgentActivity,
  type ActivityScope,
  type ActivitySubscription,
} from './activity-socket'
import {
  mergeAgentSnapshot,
  patchAgentStatusRecord,
  snapshotToRecords,
  type AgentActivityRealtimeState,
  type AgentRealtimeRecord,
  type RealtimeConnectionState,
  type WsServerMessage,
} from './realtime-snapshot'

/**
 * Agent, dashboard and thread liveness for one screen.
 *
 * The transport is the tab's single `/api/activity` socket
 * (`activity-socket.ts`): this hook contributes its scope to the union that
 * connection subscribes to and applies what comes back to the query cache.
 */
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
  const organizationId = me?.context.organizationId
  const subscriptionChannelIds = useMemo(
    () =>
      Array.from(
        new Set(
          [input.channelId, ...(input.channelIds ?? [])].filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          ),
        ),
      ).sort(),
    [input.channelId, input.channelIds],
  )
  const subscriptionKey = subscriptionChannelIds.join(',')
  const subscriptionDashboardIds = useMemo(
    () => Array.from(new Set((input.dashboardIds ?? []).filter((id) => id.length > 0))).sort(),
    [input.dashboardIds],
  )
  const dashboardSubscriptionKey = subscriptionDashboardIds.join(',')

  const scope = useMemo<ActivityScope>(
    () => ({
      channelIds: subscriptionKey.split(',').filter((id) => id.length > 0),
      dashboardIds: dashboardSubscriptionKey.split(',').filter((id) => id.length > 0),
      organizationId: organizationId ?? '',
    }),
    [dashboardSubscriptionKey, organizationId, subscriptionKey],
  )
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const invalidateAgentCaches = useCallback((agentId: string) => {
    void queryClient.invalidateQueries({ queryKey: agentKeys.activity(agentId) })
    void queryClient.invalidateQueries({ queryKey: agentKeys.children(agentId) })
    void queryClient.invalidateQueries({ queryKey: agentKeys.messages(agentId) })
    void queryClient.invalidateQueries({ queryKey: agentKeys.status(agentId) })
  }, [queryClient])

  const handleServerMessage = useCallback((message: WsServerMessage) => {
    if (message.type === 'subscribed') {
      setRecords(snapshotToRecords(message.snapshot))
      queryClient.setQueryData<AgentRecord[] | undefined>(
        agentKeys.all,
        (current) => mergeAgentSnapshot(current, message.snapshot),
      )
      // Dashboard events are advisory invalidations rather than a replay log.
      // A successful re-subscription is therefore the resync boundary after a
      // dropped socket: fetch the authoritative, ACL-checked state before a
      // compact card or workspace can keep an out-of-date revision.
      const resyncDashboardIds = scopeRef.current.dashboardIds
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

    if (message.event === 'board.updated') {
      // Content-free by design: a project id and nothing else, on the
      // organisation scope. The refetch is the entitlement check, so a
      // project id reaching somebody who is not a member reveals nothing
      // they can read — the `dashboard.updated` reasoning.
      void queryClient.invalidateQueries({
        queryKey: taskKeys.forProject(message.data.projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: projectKeys.sources(message.data.projectId),
      })
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
  }, [invalidateAgentCaches, queryClient])

  // Read through a ref so a screen may rebuild its cache handler every render
  // without churning the shared socket's subscriber list.
  const handlerRef = useRef(handleServerMessage)
  handlerRef.current = handleServerMessage
  const subscriptionRef = useRef<ActivitySubscription | null>(null)

  useEffect(() => {
    if (!token || !organizationId) {
      setConnectionState('disconnected')
      setRecords({})
      return undefined
    }

    const subscription = subscribeAgentActivity(token, {
      onMessage: (message) => handlerRef.current(message),
      onState: setConnectionState,
      scope: scopeRef.current,
    })
    subscriptionRef.current = subscription

    return () => {
      subscriptionRef.current = null
      subscription.unsubscribe()
    }
  }, [organizationId, token])

  useEffect(() => {
    subscriptionRef.current?.setScope(scope)
  }, [scope])

  return {
    connectionState,
    records,
  }
}
