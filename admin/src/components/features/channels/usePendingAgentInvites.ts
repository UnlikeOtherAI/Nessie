import { useCallback, useEffect, useState } from 'react'

import { useBindAgent } from '../../../facades/agents/hooks'
import type { PendingAgentInvite } from '../../../facades/messages/hooks'
import type { ChannelRecord } from '../../../lib/api-client'

export const usePendingAgentInvites = (activeChannel: ChannelRecord | null) => {
  const bindAgent = useBindAgent()
  const [pendingAgentInvites, setPendingAgentInvites] = useState<PendingAgentInvite[]>([])
  const [messageIds, setMessageIds] = useState<Record<string, string>>({})
  const [invitingAgentId, setInvitingAgentId] = useState<string | null>(null)
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    setPendingAgentInvites([])
    setMessageIds({})
    setInviteErrors({})
  }, [activeChannel?.id])

  const addPendingInvites = useCallback((
    invites: PendingAgentInvite[],
    triggerMessageId: string,
  ) => {
    setPendingAgentInvites((current) => {
      const seen = new Set(current.map((agent) => agent.id))
      return [...current, ...invites.filter((agent) => !seen.has(agent.id))]
    })
    setMessageIds((current) => {
      const next = { ...current }
      for (const agent of invites) next[agent.id] ??= triggerMessageId
      return next
    })
  }, [])

  const clearInviteError = useCallback((agentId: string) => {
    setInviteErrors((current) => {
      if (!(agentId in current)) return current
      const next = { ...current }
      delete next[agentId]
      return next
    })
  }, [])

  const dismissPendingAgent = useCallback((agentId: string) => {
    setPendingAgentInvites((current) => current.filter((agent) => agent.id !== agentId))
    setMessageIds((current) => {
      const next = { ...current }
      delete next[agentId]
      return next
    })
    clearInviteError(agentId)
  }, [clearInviteError])

  const invitePendingAgent = useCallback(async (agentId: string) => {
    if (!activeChannel) return
    setInvitingAgentId(agentId)
    clearInviteError(agentId)
    try {
      const triggerMessageId = messageIds[agentId]
      await bindAgent.mutateAsync({
        agentId,
        channelId: activeChannel.id,
        ...(triggerMessageId ? { triggerMessageId } : {}),
      })
      dismissPendingAgent(agentId)
    } catch (error) {
      setInviteErrors((current) => ({
        ...current,
        [agentId]: error instanceof Error && error.message
          ? error.message
          : 'Could not invite this agent. Please try again.',
      }))
    } finally {
      setInvitingAgentId(null)
    }
  }, [activeChannel, bindAgent, clearInviteError, dismissPendingAgent, messageIds])

  return {
    addPendingInvites,
    dismissPendingAgent,
    inviteErrors,
    invitePendingAgent,
    invitingAgentId,
    pendingAgentInvites,
  }
}
