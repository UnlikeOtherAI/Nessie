import { useCallback, useMemo } from 'react'
import type { AgentRecord, UserRecord } from '../../../lib/api-client'
import type { MemberUser } from './MemberUserRow'

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

type UserMemberFilterInput<T extends MemberUser> = {
  allUsers: T[]
  members: T[]
  search: string
}

export type UserMemberFilterResult<T extends MemberUser> = {
  availableUsers: T[]
  filteredUsers: T[]
}

/**
 * The person-only part of membership filtering. Projects share this with
 * channels; channels layer their bound-agent matching on top.
 */
export const useUserMemberFilters = <T extends MemberUser>({
  allUsers,
  members,
  search,
}: UserMemberFilterInput<T>): UserMemberFilterResult<T> => {
  const memberIds = useMemo(() => new Set(members.map((user) => user.id)), [members])
  const lowerSearch = search.toLowerCase().trim()
  const matchesSearch = useCallback((user: T) =>
    !lowerSearch
    || user.displayName.toLowerCase().includes(lowerSearch)
    || user.email.toLowerCase().includes(lowerSearch), [lowerSearch])

  const filteredUsers = useMemo(
    () => members.filter(matchesSearch),
    [matchesSearch, members],
  )
  const availableUsers = useMemo(
    () => allUsers.filter((user) => !memberIds.has(user.id) && matchesSearch(user)),
    [allUsers, matchesSearch, memberIds],
  )

  return { availableUsers, filteredUsers }
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
  const boundAgentIds = useMemo(
    () => new Set(boundAgents.map((a) => a.id)),
    [boundAgents],
  )

  const lowerSearch = search.toLowerCase().trim()

  const { availableUsers, filteredUsers } = useUserMemberFilters({
    allUsers,
    members: channelUsers,
    search,
  })

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
