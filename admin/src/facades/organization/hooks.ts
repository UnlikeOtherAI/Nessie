import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OrganizationSummary } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

const organizationKeys = {
  current: ['organization', 'current'] as const,
}

export const useCurrentOrganization = () => {
  const apiClient = useApiClient()

  return useQuery<OrganizationSummary>({
    queryKey: organizationKeys.current,
    queryFn: () => apiClient.get('/api/organizations/current'),
  })
}

// Owners/admins set (or clear, with `null`) the org-wide round logo. Invalidates
// the cached summary so the Logo tab and sidebar badge re-render immediately.
export const useUpdateOrganizationLogo = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (logoAttachmentId: string | null) =>
      apiClient.patch<OrganizationSummary>('/api/organizations/current', { logoAttachmentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: organizationKeys.current })
    },
  })
}
