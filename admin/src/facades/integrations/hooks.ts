import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  IntegratedProductResponse,
  IntegrationPluginManifest,
  SetProductTeamEnablementRequest,
} from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const integratedProductsKey = ['integrations', 'products'] as const
export const integrationManifestKey = (productSlug?: string) =>
  ['integrations', 'manifest', productSlug ?? 'none'] as const

export const useIntegratedProducts = () => {
  const apiClient = useApiClient()

  return useQuery<IntegratedProductResponse[]>({
    queryKey: integratedProductsKey,
    queryFn: () => apiClient.get('/api/integrations/products'),
  })
}

export const useIntegrationPluginManifest = (productSlug?: string) => {
  const apiClient = useApiClient()

  return useQuery<IntegrationPluginManifest>({
    queryKey: integrationManifestKey(productSlug),
    queryFn: () => apiClient.get(`/api/integrations/products/${productSlug}/manifest`),
    enabled: Boolean(productSlug),
  })
}

// Response shapes for the external-agent activation endpoints
// (`api/src/routes/integrations.ts`). These aren't part of `@nessie/schemas`
// yet — they're validated at the route boundary — so they're typed locally
// here rather than widening the shared client-core surface for two fields.
export type ActivateExternalAgentProductResponse = {
  channelId: string
  instanceId: string
  authorizeUrl?: string
}

export type DeactivateExternalAgentProductResponse = {
  channelId: string | null
  instanceId: string | null
}

// Per-user activation is idempotent on the backend: calling it again after a
// fresh OAuth sign-in resolves the now-active instance and flips the account
// link to `linked` without reopening the provider tab, so the same mutation
// both starts and confirms sign-in.
export const useActivateExternalAgentProduct = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (productSlug: string) =>
      apiClient.post<ActivateExternalAgentProductResponse>(
        `/api/integrations/products/${productSlug}/activate`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKey })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useDeactivateExternalAgentProduct = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (productSlug: string) =>
      apiClient.post<DeactivateExternalAgentProductResponse>(
        `/api/integrations/products/${productSlug}/deactivate`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKey })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useSetProductTeamEnablement = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (
      input: SetProductTeamEnablementRequest & { productSlug: string },
    ) =>
      apiClient.patch<IntegratedProductResponse>(
        `/api/integrations/products/${input.productSlug}/team-enablement`,
        { enabled: input.enabled },
      ),
    onSuccess: (product) => {
      queryClient.setQueryData<IntegratedProductResponse[]>(
        integratedProductsKey,
        (current) => current?.map((item) => (item.slug === product.slug ? product : item)),
      )
    },
  })
}
