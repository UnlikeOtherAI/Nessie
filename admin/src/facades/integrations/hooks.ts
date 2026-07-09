import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ChannelRecord,
  DeepTestReviewHandoffRequest,
  DeepWaterResearchLaunchRequest,
  IntegratedProductResponse,
  IntegrationPluginManifest,
  SetProductTeamEnablementRequest,
  ThreadMessageRecord,
  ThreadRecord,
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

export type DeepWaterResearchLaunchResponse = {
  channel: ChannelRecord
  message: ThreadMessageRecord
  thread: ThreadRecord
}

export type IntegrationHandoffResponse = {
  channel: ChannelRecord
  message: ThreadMessageRecord
  thread: ThreadRecord
}

export const useLaunchDeepWaterResearch = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: DeepWaterResearchLaunchRequest) =>
      apiClient.post<DeepWaterResearchLaunchResponse>(
        '/api/integrations/products/deep-water/research-launch',
        input,
      ),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKey })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
      void queryClient.invalidateQueries({
        queryKey: ['threads', response.thread.id, 'messages'],
      })
    },
  })
}

export const usePrepareDeepTestReview = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: DeepTestReviewHandoffRequest) =>
      apiClient.post<IntegrationHandoffResponse>(
        '/api/integrations/products/deeptest/security-handoff',
        input,
      ),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: integratedProductsKey })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
      void queryClient.invalidateQueries({
        queryKey: ['threads', response.thread.id, 'messages'],
      })
    },
  })
}
