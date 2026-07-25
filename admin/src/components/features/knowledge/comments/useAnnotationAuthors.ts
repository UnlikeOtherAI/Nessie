import { useMemo } from 'react'
import { useAgents } from '../../../../facades/agents/queries'
import { useUsers } from '../../../../facades/users/hooks'

export type AnnotationAuthor = {
  displayName: string
  isAgent: boolean
  avatarUrl?: string
  avatarAttachmentId?: string
  gravatarUrl?: string
  // Set for human authors only; resolves their UnlikeOtherAI avatar.
  userId?: string
}

export type AuthorResolver = (authorType: 'user' | 'agent', authorId: string) => AnnotationAuthor

// Resolves an annotation author (name + avatar) from the org's user and agent
// directories so comment rows can render the same avatar chrome as channel chat.
// Falls back to a generic label while the directories load.
export const useAnnotationAuthors = (): AuthorResolver => {
  const { data: users } = useUsers()
  const { data: agents } = useAgents()
  return useMemo(() => {
    const userMap = new Map((users ?? []).map((user) => [user.id, user]))
    const agentMap = new Map((agents ?? []).map((agent) => [agent.id, agent]))
    return (authorType, authorId) => {
      if (authorType === 'agent') {
        return { displayName: agentMap.get(authorId)?.name ?? 'Agent', isAgent: true }
      }
      const user = userMap.get(authorId)
      return {
        displayName: user?.displayName ?? 'Someone',
        isAgent: false,
        avatarUrl: user?.avatarUrl ?? undefined,
        avatarAttachmentId: user?.avatarAttachmentId ?? undefined,
        gravatarUrl: user?.gravatarUrl ?? undefined,
        userId: user?.id,
      }
    }
  }, [users, agents])
}
