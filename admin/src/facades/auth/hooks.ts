import { useQuery } from '@tanstack/react-query'
import type { AuthProviderDescriptor } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useAuthProviders = () => {
  const apiClient = useApiClient()

  return useQuery<AuthProviderDescriptor[]>({
    queryKey: ['auth', 'providers'],
    queryFn: () => apiClient.get('/api/auth/providers'),
    staleTime: 60_000,
  })
}
