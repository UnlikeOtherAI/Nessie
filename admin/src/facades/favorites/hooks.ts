import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { FavoriteRecord, FavoriteTargetType } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

const favoritesQueryKey = ['favorites'] as const

type SetFavoriteInput = {
  favorite: boolean
  targetId: string
  targetType: FavoriteTargetType
}

const sameFavorite = (
  favorite: FavoriteRecord,
  target: Pick<SetFavoriteInput, 'targetId' | 'targetType'>,
): boolean =>
  favorite.targetId === target.targetId && favorite.targetType === target.targetType

const upsertFavorite = (
  favorites: FavoriteRecord[] | undefined,
  target: Pick<SetFavoriteInput, 'targetId' | 'targetType'>,
): FavoriteRecord[] => {
  const current = favorites ?? []
  if (current.some((favorite) => sameFavorite(favorite, target))) {
    return current
  }
  return [...current, { ...target, createdAt: new Date().toISOString() }]
}

const removeFavorite = (
  favorites: FavoriteRecord[] | undefined,
  target: Pick<SetFavoriteInput, 'targetId' | 'targetType'>,
): FavoriteRecord[] =>
  (favorites ?? []).filter((favorite) => !sameFavorite(favorite, target))

export const useFavorites = () => {
  const apiClient = useApiClient()

  return useQuery<FavoriteRecord[]>({
    queryKey: favoritesQueryKey,
    queryFn: () => apiClient.get('/api/favorites'),
    staleTime: Infinity,
  })
}

export const useSetFavorite = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<
    FavoriteRecord | { ok: boolean },
    Error,
    SetFavoriteInput,
    { previous?: FavoriteRecord[] }
  >({
    mutationFn: ({ favorite, targetId, targetType }: SetFavoriteInput) =>
      favorite
        ? apiClient.put<FavoriteRecord>(`/api/favorites/${targetType}/${targetId}`)
        : apiClient.delete<{ ok: boolean }>(`/api/favorites/${targetType}/${targetId}`),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: favoritesQueryKey })
      const previous = queryClient.getQueryData<FavoriteRecord[]>(favoritesQueryKey)
      queryClient.setQueryData<FavoriteRecord[]>(favoritesQueryKey, (current) =>
        input.favorite
          ? upsertFavorite(current, input)
          : removeFavorite(current, input),
      )
      return { previous }
    },
    onError: (_error, _input, context) => {
      queryClient.setQueryData(favoritesQueryKey, context?.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: favoritesQueryKey })
    },
  })
}
