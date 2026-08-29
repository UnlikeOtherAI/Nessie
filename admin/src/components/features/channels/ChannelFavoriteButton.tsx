import type { FavoriteTargetType } from '../../../lib/api-client'

export type ChannelTitleFavorite = {
  isFavorite: boolean
  isPending: boolean
  onToggle: () => void
  targetType: FavoriteTargetType
}

