import { useQuery } from '@tanstack/react-query'
import type { IntegratedProductResponse } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const integratedProductsKey = ['integrations', 'products'] as const

export const useIntegratedProducts = () => {
  const apiClient = useApiClient()

  return useQuery<IntegratedProductResponse[]>({
    queryKey: integratedProductsKey,
    queryFn: () => apiClient.get('/api/integrations/products'),
  })
}
