import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  UoaBillingCancellationConfirmRequest,
  UoaBillingCancellationConfirmationV1,
  UoaBillingCancellationPreviewV1,
  UoaBillingRedirectResponse,
  UoaBillingStatementV1,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'

export const billingStatementKey = ['uoa-billing-statement'] as const

export const useUoaBillingStatement = () => {
  const apiClient = useApiClient()
  return useQuery<UoaBillingStatementV1>({
    queryKey: billingStatementKey,
    queryFn: () => apiClient.get('/api/billing/statement'),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  })
}

export const useUoaBillingHostedAction = () => {
  const apiClient = useApiClient()
  return useMutation<
    UoaBillingRedirectResponse,
    unknown,
    'portal' | 'upgrade'
  >({
    mutationFn: (id) =>
      apiClient.post(`/api/billing/actions/${id}`),
  })
}

export const useUoaBillingCancellationPreview = () => {
  const apiClient = useApiClient()
  return useMutation<UoaBillingCancellationPreviewV1>({
    mutationFn: () =>
      apiClient.post('/api/billing/cancellation/preview'),
  })
}

export const useUoaBillingCancellationConfirm = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<
    UoaBillingCancellationConfirmationV1,
    unknown,
    UoaBillingCancellationConfirmRequest
  >({
    mutationFn: (request) =>
      apiClient.post('/api/billing/cancellation/confirm', request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingStatementKey })
    },
  })
}

