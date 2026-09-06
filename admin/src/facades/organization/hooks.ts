import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OrganizationTheme } from '@nessie/schemas'
import type { OrganizationSummary } from '../../lib/api-client'
import { organizationKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

export const useCurrentOrganization = () => {
  const apiClient = useApiClient()
  const { sessionState } = useAuthSession()

  return useQuery<OrganizationSummary>({
    // ThemeProvider observes this to paint the organisation's palette, so it
    // must not fire on the sign-in screen, which has no session to answer with.
    enabled: sessionState === 'authenticated',
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

/**
 * Owners/admins save (or clear, with `null`) the organisation's colour scheme.
 *
 * Saving is what makes it the default — there is no separate switch — so the
 * summary is invalidated to repaint everyone's shell and refresh the theme card
 * on the Colours panel.
 */
export const useUpdateOrganizationTheme = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (theme: OrganizationTheme | null) =>
      apiClient.patch<OrganizationSummary>('/api/organizations/current', { theme }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: organizationKeys.current })
    },
  })
}
