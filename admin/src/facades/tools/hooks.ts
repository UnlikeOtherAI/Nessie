import { useQuery } from '@tanstack/react-query'
import type { ToolDescriptor } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useTools = () => {
  const apiClient = useApiClient()

  return useQuery<ToolDescriptor[]>({
    queryKey: ['tools'],
    queryFn: () => apiClient.get('/api/tools'),
  })
}
