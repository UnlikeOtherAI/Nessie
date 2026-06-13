import type { FavoriteTargetType } from '../../../lib/api-client'

export type ChannelTitleFavorite = {
  isFavorite: boolean
  isPending: boolean
  onToggle: () => void
  targetType: FavoriteTargetType
}

const targetLabel: Record<FavoriteTargetType, string> = {
  agent: 'agent',
  channel: 'channel',
  user: 'person',
}

export const ChannelFavoriteButton = ({ favorite }: { favorite: ChannelTitleFavorite | null }) => {
  if (!favorite) {
    return null
  }

  const action = favorite.isFavorite ? 'Remove favorite' : 'Add favorite'
  const label = `${action} ${targetLabel[favorite.targetType]}`

  return (
    <button
      aria-label={label}
      aria-pressed={favorite.isFavorite}
      className={[
        'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded',
        favorite.isFavorite
          ? 'text-[var(--warning)] hover:bg-[var(--overlay)]'
          : 'text-[color:var(--tx3)] hover:bg-[var(--overlay)]',
        favorite.isPending ? 'opacity-60' : '',
      ].join(' ')}
      disabled={favorite.isPending}
      onClick={favorite.onToggle}
      title={label}
      type="button"
    >
      <svg
        aria-hidden="true"
        className="h-4 w-4"
        fill={favorite.isFavorite ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
        viewBox="0 0 24 24"
      >
        <path d="M12 3.75l2.57 5.2 5.74.83-4.16 4.05.98 5.72L12 16.85l-5.13 2.7.98-5.72-4.16-4.05 5.74-.83L12 3.75z" />
      </svg>
    </button>
  )
}
