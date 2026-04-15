import { useQuery } from '@tanstack/react-query'
import type { ProjectRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useProjects = () => {
  const apiClient = useApiClient()

  return useQuery<ProjectRecord[]>({
    queryKey: ['projects'],
    queryFn: () => apiClient.get('/api/projects'),
    staleTime: Infinity,
  })
}
