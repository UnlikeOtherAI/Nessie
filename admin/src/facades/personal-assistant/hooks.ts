import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ChannelRecord,
  PersonalAssistantBootstrapResponse,
  PersonalAssistantStateResponse,
} from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

const personalAssistantQueryKey = ['personal-assistant'] as const

const upsertChannel = (
  current: ChannelRecord[] | undefined,
  channel: ChannelRecord,
): ChannelRecord[] => {
  if (!current) {
    return [channel]
  }

  const existingIndex = current.findIndex((entry) => entry.id === channel.id)
  if (existingIndex === -1) {
    return [channel, ...current]
  }

  return current.map((entry) => (entry.id === channel.id ? channel : entry))
}

export const isPersonalAssistantChannel = (channel?: ChannelRecord | null): boolean =>
  channel?.metadata?.systemChannelType === 'personal_assistant'

export const usePersonalAssistant = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<PersonalAssistantStateResponse | null>({
    enabled,
    queryKey: personalAssistantQueryKey,
    queryFn: () => apiClient.get('/api/personal-assistant'),
    retry: false,
    staleTime: 30_000,
  })
}

export const usePersonalAssistantBootstrap = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () =>
      apiClient.post<PersonalAssistantBootstrapResponse>('/api/personal-assistant/bootstrap'),
    onSuccess: (response) => {
      queryClient.setQueryData<ChannelRecord[] | undefined>(
        ['channels'],
        (current) => upsertChannel(current, response.channel),
      )
      queryClient.setQueryData(personalAssistantQueryKey, {
        agent: response.agent,
        channel: response.channel,
        instance: response.instance ?? null,
        thread: response.thread,
      } satisfies PersonalAssistantStateResponse)
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
      void queryClient.invalidateQueries({ queryKey: personalAssistantQueryKey })
    },
  })
}
