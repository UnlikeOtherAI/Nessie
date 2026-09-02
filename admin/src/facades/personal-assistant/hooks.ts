import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ChannelRecord,
  PersonalAssistantBootstrapResponse,
  PersonalAssistantStateResponse,
} from '../../lib/api-client'
import { channelKeys, personalAssistantKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { upsertChannel } from '../channels/channel-cache'

export const isPersonalAssistantChannel = (channel?: ChannelRecord | null): boolean =>
  channel?.systemChannelType === 'personal_assistant'
  || channel?.metadata?.systemChannelType === 'personal_assistant'

// External agents (e.g. DeepSignal) are a peer of the Personal Assistant: a
// per-user private DM channel proxied to an external product over MCP, keyed
// by `systemChannelType` the same way the PA channel is. New external agents
// are a data change on the backend, not a UI code fork — this predicate stays
// generic across all of them.
export const isExternalAgentChannel = (channel?: ChannelRecord | null): boolean =>
  channel?.systemChannelType === 'external_agent'
  || channel?.metadata?.systemChannelType === 'external_agent'

// A global agent (the Agent Designer, ...) lives in a per-user private DM of
// its own, keyed by `systemChannelType` exactly as the two above are. New
// global agents are a backend blueprint entry, not a UI code fork.
export const isGlobalAgentChannel = (channel?: ChannelRecord | null): boolean =>
  channel?.systemChannelType === 'system_agent'
  || channel?.metadata?.systemChannelType === 'system_agent'

export const isUserDmChannel = (channel?: ChannelRecord | null): boolean =>
  channel?.type === 'dm'
  && !isPersonalAssistantChannel(channel)
  && !isExternalAgentChannel(channel)
  && !isGlobalAgentChannel(channel)
  && Boolean(channel.dmUserId)

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
