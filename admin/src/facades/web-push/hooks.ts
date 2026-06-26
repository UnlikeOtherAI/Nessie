import { useMutation, useQuery } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'

export type WebPushConfig = {
  enabled: boolean
  publicKey: string | null
}

const CONFIG_QUERY_KEY = ['web-push', 'config'] as const

export const useWebPushConfig = () => {
  const apiClient = useApiClient()

  return useQuery<WebPushConfig>({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: () => apiClient.get('/api/push/web/config'),
    staleTime: Infinity,
  })
}

export const useSubscribeWebPush = () => {
  const apiClient = useApiClient()

  return useMutation<void, Error, PushSubscriptionJSON>({
    mutationFn: (subscription) =>
      apiClient.post<void>('/api/push/web/subscribe', subscription),
  })
}

export const useUnsubscribeWebPush = () => {
  const apiClient = useApiClient()

  return useMutation<void, Error, { endpoint: string }>({
    mutationFn: (body) => apiClient.post<void>('/api/push/web/unsubscribe', body),
  })
}
