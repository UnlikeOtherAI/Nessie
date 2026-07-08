import { useQuery } from '@tanstack/react-query'
import type {
  IntegratedProductResponse,
  IntegrationPluginManifest,
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
