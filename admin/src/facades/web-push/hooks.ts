import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { webPushKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type WebPushConfig = {
  enabled: boolean
  publicKey: string | null
  registeredEndpoints: string[]
}

export const useWebPushConfig = () => {
  const apiClient = useApiClient()

  return useQuery<WebPushConfig>({
    queryKey: webPushKeys.config,
    queryFn: () => apiClient.get('/api/push/web/config'),
    staleTime: Infinity,
  })
}

export const useSubscribeWebPush = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<{ endpoint: string }, Error, PushSubscriptionJSON>({
    mutationFn: (subscription) =>
      apiClient.post<{ endpoint: string }>('/api/push/web/subscribe', subscription),
    onSuccess: (subscription) => {
      queryClient.setQueryData<WebPushConfig>(webPushKeys.config, (current) => current && ({
        ...current,
        registeredEndpoints: [...new Set([...current.registeredEndpoints, subscription.endpoint])],
      }))
    },
  })
}

export const useUnsubscribeWebPush = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<void, Error, { endpoint: string }>({
    mutationFn: (body) => apiClient.post<void>('/api/push/web/unsubscribe', body),
    onSuccess: (_result, input) => {
      queryClient.setQueryData<WebPushConfig>(webPushKeys.config, (current) => current && ({
        ...current,
        registeredEndpoints: current.registeredEndpoints.filter((endpoint) => endpoint !== input.endpoint),
      }))
    },
  })
}
