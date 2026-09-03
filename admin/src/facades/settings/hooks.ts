import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../../providers/ApiClientProvider'

export type SettingScope = 'organization' | 'team' | 'user'

export type ResolvedSetting<T = unknown> = {
  key: string
  value: T | null
  setAtScope: SettingScope | null
  /** The level that stopped everything below it overriding, or null. */
  lockedAtScope: SettingScope | null
  /** Whether the level being viewed may still change this. */
  canEdit: boolean
  /** Whether the level being viewed currently holds the lock. */
  lockedHere: boolean
}

export const scopedSettingKeys = {
  all: ['scoped-settings'] as const,
  list: (scope: SettingScope, teamId: string | null, keys: readonly string[]) =>
    ['scoped-settings', scope, teamId ?? 'none', [...keys].sort().join(',')] as const,
}

/** The setting keys the cascade governs today. */
export const SETTING_KEYS = {
  browserConnection: 'browser.connection',
  callsProvider: 'calls.provider',
} as const

export const useScopedSettings = (
  scope: SettingScope,
  keys: readonly string[],
  teamId: string | null = null,
) => {
  const apiClient = useApiClient()
  const query = new URLSearchParams({ keys: keys.join(','), scope })
  if (teamId) query.set('teamId', teamId)
  return useQuery<{ settings: ResolvedSetting[] }>({
    enabled: keys.length > 0,
    // Switching team keeps the previous answer on screen rather than blanking
    // the control mid-read — see docs/navigation/overview.md, "Arriving with
    // content".
    placeholderData: keepPreviousData,
    queryKey: scopedSettingKeys.list(scope, teamId, keys),
    queryFn: () => apiClient.get(`/api/settings/scoped?${query.toString()}`),
  })
}

export type WriteScopedSettingInput = {
  key: string
  scope: SettingScope
  teamId?: string | null
  value?: unknown
  locked: boolean
}

export const useWriteScopedSetting = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ key, ...body }: WriteScopedSettingInput) =>
      apiClient.put<{ settings: ResolvedSetting[] }>(
        `/api/settings/scoped/${encodeURIComponent(key)}`,
        body,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scopedSettingKeys.all })
    },
  })
}

/** Pull one key out of a settings query without re-deriving the default shape. */
export const settingFor = (
  data: { settings: ResolvedSetting[] } | undefined,
  key: string,
): ResolvedSetting | undefined => data?.settings.find((setting) => setting.key === key)
