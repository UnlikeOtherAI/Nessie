import { useQuery } from '@tanstack/react-query'
import type { ToolDescriptor } from '../../lib/api-client'
import { toolKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useTools = () => {
  const apiClient = useApiClient()

  return useQuery<ToolDescriptor[]>({
    queryKey: toolKeys.all,
    queryFn: () => apiClient.get('/api/tools'),
  })
}
