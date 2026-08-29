import { useMutation, useQuery } from '@tanstack/react-query'
import { webPushKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type WebPushConfig = {
  enabled: boolean
  publicKey: string | null
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
