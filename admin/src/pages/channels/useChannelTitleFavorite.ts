import { useCallback, useMemo } from 'react'

import type { AgentRecord, ChannelRecord, FavoriteTargetType } from '../../lib/api-client'
import { useFavorites, useSetFavorite } from '../../facades/favorites/hooks'
import {
  isPersonalAssistantChannel,
  isUserDmChannel,
} from '../../facades/personal-assistant/hooks'

type FavoriteTarget = {
  targetId: string
  targetType: FavoriteTargetType
}

type UseChannelTitleFavoriteInput = {
  activeChannel: ChannelRecord | null
  personalAssistantAgent: AgentRecord | null
}

export const useChannelTitleFavorite = ({
  activeChannel,
  personalAssistantAgent,
}: UseChannelTitleFavoriteInput) => {
  const { data: favorites = [] } = useFavorites()
  const setFavorite = useSetFavorite()
  const target = useMemo<FavoriteTarget | null>(() => {
    if (!activeChannel) {
      return null
    }

    if (isPersonalAssistantChannel(activeChannel)) {
      return personalAssistantAgent
        ? { targetId: personalAssistantAgent.id, targetType: 'agent' }
        : null
    }

    if (isUserDmChannel(activeChannel) && activeChannel.dmUserId) {
      return { targetId: activeChannel.dmUserId, targetType: 'user' }
    }

    return { targetId: activeChannel.id, targetType: 'channel' }
  }, [activeChannel, personalAssistantAgent])

  const isFavorite = target
    ? favorites.some(
        (favorite) =>
          favorite.targetId === target.targetId && favorite.targetType === target.targetType,
      )
    : false

  const onToggle = useCallback(() => {
    if (!target) {
      return
    }
    setFavorite.mutate({ ...target, favorite: !isFavorite })
  }, [isFavorite, setFavorite, target])

  return target
    ? {
        isFavorite,
        isPending: setFavorite.isPending,
        onToggle,
        targetType: target.targetType,
      }
    : null
}
