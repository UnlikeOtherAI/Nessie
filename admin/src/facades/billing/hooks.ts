import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  BillingCancellationConfirmRequest,
  BillingCancellationConfirmationV1,
  BillingCancellationPreviewV1,
  BillingHostedRedirectResponse,
  BillingStatementV2,
} from '@unlikeotherai/billing-statement-protocol'
import { useApiClient } from '../../providers/ApiClientProvider'

export const billingStatementKey = ['uoa-billing-statement'] as const

export const useUoaBillingStatement = () => {
  const apiClient = useApiClient()
  return useQuery<BillingStatementV2>({
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
    BillingHostedRedirectResponse,
    unknown,
    'portal' | 'upgrade'
  >({
    mutationFn: (id) =>
      apiClient.post(`/api/billing/actions/${id}`),
  })
}

export const useUoaBillingCancellationPreview = () => {
  const apiClient = useApiClient()
  return useMutation<BillingCancellationPreviewV1>({
    mutationFn: () =>
      apiClient.post('/api/billing/cancellation/preview'),
  })
}

export const useUoaBillingCancellationConfirm = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<
    BillingCancellationConfirmationV1,
    unknown,
    BillingCancellationConfirmRequest
  >({
    mutationFn: (request) =>
      apiClient.post('/api/billing/cancellation/confirm', request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingStatementKey })
    },
  })
}
