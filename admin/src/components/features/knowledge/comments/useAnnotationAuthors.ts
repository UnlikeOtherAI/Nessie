import { useMemo } from 'react'
import { useAgents } from '../../../../facades/agents/queries'
import { useUsers } from '../../../../facades/users/hooks'

export type AuthorResolver = (authorType: 'user' | 'agent', authorId: string) => string

// Resolves an annotation author's display name from the org's user and agent
// directories. Falls back to a generic label while the directories load or when
// the author is no longer present.
export const useAnnotationAuthors = (): AuthorResolver => {
  const { data: users } = useUsers()
  const { data: agents } = useAgents()
  return useMemo(() => {
    const userMap = new Map((users ?? []).map((user) => [user.id, user.displayName]))
    const agentMap = new Map((agents ?? []).map((agent) => [agent.id, agent.name]))
    return (authorType, authorId) =>
      authorType === 'agent'
        ? agentMap.get(authorId) ?? 'Agent'
        : userMap.get(authorId) ?? 'Someone'
  }, [users, agents])
}
