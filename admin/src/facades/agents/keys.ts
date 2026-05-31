import type { z } from 'zod'
import type { WsSnapshot } from '@nessie/schemas'
import { WsServerMessageSchema } from '@nessie/schemas'
import { getBaseUrl, type AgentRecord } from '../../lib/api-client'

export type RealtimeConnectionState = 'connected' | 'connecting' | 'disconnected'

export type AgentRealtimeRecord = {
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

export type WsServerMessage = z.infer<typeof WsServerMessageSchema>

export const resolveWebSocketUrl = (token: string): string => {
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

export const mergeAgentSnapshot = (
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

export const snapshotToRecords = (snapshot: WsSnapshot): Record<string, AgentRealtimeRecord> =>
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
