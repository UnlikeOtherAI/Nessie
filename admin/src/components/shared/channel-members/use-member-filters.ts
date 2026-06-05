import { useMemo } from 'react'
import type { AgentRecord, UserRecord } from '../../../lib/api-client'

type MemberFilterInput = {
  allAgents: AgentRecord[]
  allUsers: UserRecord[]
  boundAgents: AgentRecord[]
  channelUsers: UserRecord[]
  search: string
}

export type MemberFilterResult = {
  filteredUsers: UserRecord[]
  filteredAgents: AgentRecord[]
  availableUsers: UserRecord[]
  availableAgents: AgentRecord[]
  totalMembers: number
  hasAvailable: boolean
}

/**
 * Pure list-shaping for the channel-members popup: derives the
 * already-in-channel and available-to-add user/agent lists from the search
 * term and the source collections.
 */
export const useMemberFilters = ({
  allAgents,
  allUsers,
  boundAgents,
  channelUsers,
  search,
}: MemberFilterInput): MemberFilterResult => {
  const channelUserIds = useMemo(
    () => new Set(channelUsers.map((u) => u.id)),
    [channelUsers],
  )
  const boundAgentIds = useMemo(
    () => new Set(boundAgents.map((a) => a.id)),
    [boundAgents],
  )

  const lowerSearch = search.toLowerCase().trim()

  const filteredUsers = useMemo(
    () =>
      channelUsers.filter(
        (u) =>
          !lowerSearch ||
          u.displayName.toLowerCase().includes(lowerSearch) ||
          u.email.toLowerCase().includes(lowerSearch),
      ),
    [channelUsers, lowerSearch],
  )

  const filteredAgents = useMemo(
    () =>
      boundAgents.filter(
        (a) =>
          !lowerSearch ||
          a.name.toLowerCase().includes(lowerSearch) ||
          a.role.toLowerCase().includes(lowerSearch),
      ),
    [boundAgents, lowerSearch],
  )

  const availableUsers = useMemo(
    () =>
      allUsers.filter(
        (u) =>
          !channelUserIds.has(u.id) &&
          (!lowerSearch ||
            u.displayName.toLowerCase().includes(lowerSearch) ||
            u.email.toLowerCase().includes(lowerSearch)),
      ),
    [allUsers, channelUserIds, lowerSearch],
  )

  const availableAgents = useMemo(
    () =>
      allAgents.filter(
        (a) =>
          !boundAgentIds.has(a.id) &&
          (!lowerSearch ||
            a.name.toLowerCase().includes(lowerSearch) ||
            a.role.toLowerCase().includes(lowerSearch)),
      ),
    [allAgents, boundAgentIds, lowerSearch],
  )

  const totalMembers = channelUsers.length + boundAgents.length
  const hasAvailable = availableUsers.length > 0 || availableAgents.length > 0

  return {
    filteredUsers,
    filteredAgents,
    availableUsers,
    availableAgents,
    totalMembers,
    hasAvailable,
  }
}
