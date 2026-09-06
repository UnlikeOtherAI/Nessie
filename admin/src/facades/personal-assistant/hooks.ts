import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ChannelRecord,
  PersonalAssistantBootstrapResponse,
  PersonalAssistantStateResponse,
} from '../../lib/api-client'
import { channelKeys } from '../channels/keys'
import { personalAssistantKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { upsertChannel } from '../channels/channel-cache'

export {
  isExternalAgentChannel,
  isGlobalAgentChannel,
  isPersonalAssistantChannel,
  isUserDmChannel,
} from './channel-kinds'

export const usePersonalAssistant = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<PersonalAssistantStateResponse | null>({
    enabled,
    queryKey: personalAssistantKeys.all,
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
        channelKeys.all,
        (current) => upsertChannel(current, response.channel),
      )
      queryClient.setQueryData(personalAssistantKeys.all, {
        agent: response.agent,
        channel: response.channel,
        configSummary: response.configSummary,
        instance: response.instance ?? null,
        thread: response.thread,
      } satisfies PersonalAssistantStateResponse)
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
      void queryClient.invalidateQueries({ queryKey: personalAssistantKeys.all })
    },
  })
}

// PA presence is a channel-member action, not generic agent binding. Keeping
// its mutation beside the PA facade prevents a caller from accidentally using
// the ordinary binding route (which correctly refuses the singleton PA).
export const useAddPersonalAssistantPresence = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (channelId: string) =>
      apiClient.post(`/api/channels/${channelId}/personal-assistant`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
    },
  })
}

export const useRemovePersonalAssistantPresence = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (channelId: string) =>
      apiClient.delete(`/api/channels/${channelId}/personal-assistant`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
    },
  })
}
