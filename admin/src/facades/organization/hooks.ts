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
// the cached summary so the Logo panel and sidebar badge re-render immediately.
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

// Owners/admins rename the organisation. Invalidates the cached summary so the
// org name re-renders everywhere it is shown.
export const useUpdateOrganization = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { name: string }) =>
      apiClient.patch<OrganizationSummary>('/api/organizations/current', { name: input.name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: organizationKeys.current })
    },
  })
}
