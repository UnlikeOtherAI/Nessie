import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import type {
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentStatusResponse,
  ToolCallEntry,
  WsSnapshot,
} from '@nessie/schemas'
import { WsServerMessageSchema } from '@nessie/schemas'
import { getBaseUrl, type AgentRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

type RealtimeConnectionState = 'connected' | 'connecting' | 'disconnected'

type AgentRealtimeRecord = {
  currentRunId?: string
  currentToolName?: string
  currentToolStartedAt?: string
  since?: string
  status: AgentRecord['status']
}

export type AgentActivityRealtimeState = {
  connectionState: RealtimeConnectionState
  records: Record<string, AgentRealtimeRecord>
}

type WsServerMessage = z.infer<typeof WsServerMessageSchema>

const resolveWebSocketUrl = (token: string): string => {
  const baseUrl = getBaseUrl()
  if (baseUrl) {
    const url = new URL(baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/api/activity'
    url.searchParams.set('token', token)
    return url.toString()
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = new URL(`${protocol}//${window.location.host}/api/activity`)
  url.searchParams.set('token', token)
  return url.toString()
}

const mergeAgentSnapshot = (
  agents: AgentRecord[] | undefined,
  snapshot: WsSnapshot,
): AgentRecord[] | undefined =>
  agents?.map((agent) => {
    const next = snapshot.agents.find((candidate) => candidate.agentId === agent.id)
    if (!next) {
      return agent
    }

    return {
      ...agent,
      currentRunId: next.currentRunId,
      currentToolName: next.currentToolName,
      currentToolStartedAt: next.currentToolStartedAt,
      lastActivityAt: next.currentToolStartedAt ?? next.since ?? agent.lastActivityAt,
      status: next.status,
    }
  })

const snapshotToRecords = (snapshot: WsSnapshot): Record<string, AgentRealtimeRecord> =>
  Object.fromEntries(
    snapshot.agents.map((agent) => [
      agent.agentId,
      {
        currentRunId: agent.currentRunId,
        currentToolName: agent.currentToolName,
        currentToolStartedAt: agent.currentToolStartedAt,
        since: agent.since,
        status: agent.status,
      },
    ]),
  )

export const useAgents = () => {
  const apiClient = useApiClient()

  return useQuery<AgentRecord[]>({
    queryKey: ['agents'],
    queryFn: () => apiClient.get('/api/agents'),
  })
}

export const useCreateAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { name: string; role: string; systemPrompt?: string }) =>
      apiClient.post<AgentRecord>('/api/agents', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export const useBindAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; channelId: string }) =>
      apiClient.post(`/api/agents/${input.agentId}/bindings`, {
        channelId: input.channelId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export const useAgentStatus = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentStatusResponse>({
    queryKey: ['agents', agentId, 'status'],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/status`),
    enabled: Boolean(agentId),
  })
}

export const useAgentActivity = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentActivityResponse>({
    queryKey: ['agents', agentId, 'activity'],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/activity`),
    enabled: Boolean(agentId),
  })
}

export const useAgentMessages = (agentId?: string, limit = 5) => {
  const apiClient = useApiClient()

  return useQuery<AgentMessage[]>({
    queryKey: ['agents', agentId, 'messages', limit],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/messages?limit=${limit}`),
    enabled: Boolean(agentId),
  })
}

export const useAgentChildren = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentChild[]>({
    queryKey: ['agents', agentId, 'children'],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/children`),
    enabled: Boolean(agentId),
  })
}

export const useRunToolCalls = (agentId?: string, runId?: string) => {
  const apiClient = useApiClient()

  return useQuery<ToolCallEntry[]>({
    queryKey: ['agents', agentId, 'runs', runId, 'tools'],
    queryFn: () => apiClient.get(`/api/agents/${agentId}/runs/${runId}/tools`),
    enabled: Boolean(agentId && runId),
  })
}

export const patchAgentStatusRecord = (
  agents: AgentRecord[] | undefined,
  event: {
    currentRunId?: string
    currentToolName?: string
    currentToolStartedAt?: string
    agentId: string
    status: AgentRecord['status']
    ts?: string
  },
): AgentRecord[] | undefined =>
  agents?.map((agent) =>
    agent.id === event.agentId
      ? {
        ...agent,
        currentRunId: event.currentRunId ?? agent.currentRunId,
        currentToolName:
          event.currentToolName === undefined ? agent.currentToolName : event.currentToolName,
        currentToolStartedAt:
          event.currentToolStartedAt === undefined
            ? agent.currentToolStartedAt
            : event.currentToolStartedAt,
        lastActivityAt: event.currentToolStartedAt ?? event.ts ?? agent.lastActivityAt,
        status: event.status,
      }
      : agent,
  )

export const useAgentRealtime = (input: {
  channelId?: string
  organizationId?: string
  threadId?: string
}): AgentActivityRealtimeState => {
  const queryClient = useQueryClient()
  const { me, token } = useAuthSession()
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>('disconnected')
  const [records, setRecords] = useState<Record<string, AgentRealtimeRecord>>({})
  const threadIdRef = useRef(input.threadId)
  threadIdRef.current = input.threadId

  useEffect(() => {
    if (!token || !me?.context.organizationId) {
      setConnectionState('disconnected')
      setRecords({})
      return
    }

    let closed = false
    let reconnectTimer: number | undefined
    let socket: WebSocket | null = null

    const clearReconnectTimer = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
    }

    const invalidateAgentCaches = (agentId: string) => {
      void queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'activity'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'children'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'messages'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'status'] })
    }

    const handleServerMessage = (message: WsServerMessage) => {
      if (message.type === 'subscribed') {
        setConnectionState('connected')
        setRecords(snapshotToRecords(message.snapshot))
        queryClient.setQueryData<AgentRecord[] | undefined>(
          ['agents'],
          (current) => mergeAgentSnapshot(current, message.snapshot),
        )
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
          ['agents'],
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
          ['agents', message.data.agentId, 'status'],
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
        void queryClient.invalidateQueries({ queryKey: ['agents'] })
        return
      }

      if (message.event === 'run.updated') {
        invalidateAgentCaches(message.data.agentId)
        return
      }

      if (message.event === 'message.new') {
        invalidateAgentCaches(message.data.agentId)
        if (message.data.threadId === threadIdRef.current) {
          void queryClient.invalidateQueries({
            queryKey: ['threads', message.data.threadId, 'messages'],
          })
        }
        return
      }
    }

    const connect = () => {
      clearReconnectTimer()
      setConnectionState('connecting')

      socket = new WebSocket(resolveWebSocketUrl(token))

      socket.addEventListener('open', () => {
        socket?.send(
          JSON.stringify({
            type: 'set_subscriptions',
            scopes: [
              {
                kind: 'organization',
                organizationId: me.context.organizationId,
              },
            ],
          }),
        )
      })

      socket.addEventListener('message', (event) => {
        const parsed = WsServerMessageSchema.safeParse(JSON.parse(event.data as string))
        if (!parsed.success) {
          return
        }

        handleServerMessage(parsed.data)
      })

      socket.addEventListener('close', () => {
        if (closed) {
          return
        }

        setConnectionState('disconnected')
        reconnectTimer = window.setTimeout(connect, 1_500)
      })

      socket.addEventListener('error', () => {
        socket?.close()
      })
    }

    connect()

    return () => {
      closed = true
      clearReconnectTimer()
      socket?.close()
    }
  }, [me?.context.organizationId, queryClient, token])

  return {
    connectionState,
    records,
  }
}

export const useUnbindAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; channelId: string }) =>
      apiClient.delete(
        `/api/agents/${input.agentId}/bindings/${input.channelId}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export const useCloneAgent = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (agentId: string) =>
      apiClient.post<AgentRecord>(`/api/agents/${agentId}/clone`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export const useAgentActivityRealtime = useAgentRealtime
