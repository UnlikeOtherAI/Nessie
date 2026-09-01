import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isUserDmChannel } from '../personal-assistant/hooks'
import { useUsers } from '../users/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useChannels, useOpenDm, useStartChannelConversation } from './hooks'

/**
 * "Open the DM with this person" — the one implementation, shared by the admin
 * shell's people lists and by any other surface that lists users (the project
 * dashboard's Members section).
 *
 * `POST /api/dm/:userId` already resolves an existing DM server-side, so the
 * client-side lookup below is purely an optimisation that avoids a round trip
 * and a channel-list invalidation. It depends on `GET /api/users`, which is
 * owner-gated — hence `useUsers(false)`: this hook never issues that request
 * itself, it only reads the cached list when some owner-only surface has
 * already loaded it, and falls through to the mutation for everyone else.
 * A member clicking a member must still land in the DM.
 */
export const useNavigateToDm = (): ((userId: string) => void) => {
  const navigate = useNavigate()
  const { me } = useAuthSession()
  const { data: channels = [] } = useChannels()
  const { data: users = [] } = useUsers(false)
  const openDm = useOpenDm()

  return useCallback(
    (userId: string) => {
      const targetUser = userId === me?.user.id ? undefined : users.find((u) => u.id === userId)
      const existing = targetUser
        ? channels.find((c) => isUserDmChannel(c) && targetUser.channelIds.includes(c.id))
        : undefined

      if (existing) {
        void navigate(`/channels/${existing.id}`)
        return
      }

      openDm.mutate(userId, {
        onSuccess: (channel) => {
          void navigate(`/channels/${channel.id}`)
        },
      })
    },
    [channels, me?.user.id, navigate, openDm, users],
  )
}

/**
 * Opens the one-to-one conversation with an agent. Agent channel bindings are
 * also used by ordinary channels, so the server's stable DM key is the only
 * authority for resolving this destination.
 */
export const useNavigateToAgentDm = (): ((agentId: string) => void) => {
  const navigate = useNavigate()
  const startConversation = useStartChannelConversation()

  return useCallback(
    (agentId: string) => {
      startConversation.mutate(
        { agentIds: [agentId] },
        {
          onSuccess: (channel) => {
            void navigate(`/channels/${channel.id}`)
          },
        },
      )
    },
    [navigate, startConversation],
  )
}
