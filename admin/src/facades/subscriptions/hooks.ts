import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { agentKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * React-Query facade for personal model subscriptions.
 *
 * Every call is scoped server-side to the session user — the client never
 * passes an owner id, and no response here can carry credential material.
 */

export type ModelSubscriptionProviderOption = {
  authStrategy: 'api_key' | 'oauth_device'
  displayName: string
  key: string
  models: { model: string; displayName: string; description?: string }[]
  termsNote: string
}

export type ModelSubscriptionProvidersResponse = {
  /** False when the deployment has no credential vault configured. */
  available: boolean
  providers: ModelSubscriptionProviderOption[]
}

export type ModelSubscription = {
  accountLabel: string | null
  createdAt: string
  displayName: string
  healthDetail: string | null
  healthReason: string
  id: string
  lastUsedAt: string | null
  models: { model: string; displayName: string; description?: string }[]
  provider: string
  status: 'active' | 'needs_reauthorization' | 'disconnected' | 'error'
}

export const subscriptionKeys = {
  list: ['model-subscriptions'] as const,
  providers: ['model-subscriptions', 'providers'] as const,
}

export const useModelSubscriptionProviders = () => {
  const apiClient = useApiClient()
  return useQuery<ModelSubscriptionProvidersResponse>({
    queryFn: () => apiClient.get('/api/model-subscriptions/providers'),
    queryKey: subscriptionKeys.providers,
  })
}

export const useModelSubscriptions = () => {
  const apiClient = useApiClient()
  return useQuery<ModelSubscription[]>({
    queryFn: () => apiClient.get('/api/model-subscriptions'),
    queryKey: subscriptionKeys.list,
  })
}

export const useLinkModelSubscription = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { provider: string; apiKey: string; subscriptionId?: string }) =>
      apiClient.post<ModelSubscription>('/api/model-subscriptions', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: subscriptionKeys.list })
      // The Agent Designer picker composes its options from these links, so a
      // new link has to invalidate the model list too or the option a person
      // just created stays missing until the next reload.
      void queryClient.invalidateQueries({ queryKey: agentKeys.models })
    },
  })
}

export const useDisconnectModelSubscription = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/model-subscriptions/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: subscriptionKeys.list })
      void queryClient.invalidateQueries({ queryKey: agentKeys.models })
    },
  })
}
