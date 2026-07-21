import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  BillingCancellationConfirmRequest,
  BillingCancellationConfirmationV1,
  BillingCancellationPreviewV1,
  BillingCreditsV1,
  BillingHostedRedirectResponse,
  BillingRecurringAddonCancellationConfirmationV1,
  BillingRecurringAddonCancellationPreviewV1,
  BillingRecurringAddonsV1,
  BillingStatementV2,
} from '@unlikeotherai/billing-statement-protocol'
import { useApiClient } from '../../providers/ApiClientProvider'

export const billingStatementKey = ['uoa-billing-statement'] as const
export const billingCreditsKey = ['uoa-billing-credits'] as const
export const billingRecurringAddonsKey = [
  'uoa-billing-recurring-addons',
] as const

export const useUoaBillingCredits = () => {
  const apiClient = useApiClient()
  return useQuery<BillingCreditsV1>({
    queryKey: billingCreditsKey,
    queryFn: () => apiClient.get('/api/billing/credits'),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 30_000,
  })
}

export const useUoaBillingRecurringAddons = () => {
  const apiClient = useApiClient()
  return useQuery<BillingRecurringAddonsV1>({
    queryKey: billingRecurringAddonsKey,
    queryFn: () => apiClient.get('/api/billing/recurring-addons'),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 30_000,
  })
}

const invalidateFunding = (queryClient: ReturnType<typeof useQueryClient>) => {
  void queryClient.invalidateQueries({ queryKey: billingCreditsKey })
  void queryClient.invalidateQueries({ queryKey: billingRecurringAddonsKey })
  void queryClient.invalidateQueries({ queryKey: billingStatementKey })
}

export const useUoaBillingCreditTopUp = () => {
  const apiClient = useApiClient()
  return useMutation<BillingHostedRedirectResponse, unknown, string>({
    mutationFn: (offerId) =>
      apiClient.post(`/api/billing/credits/top-ups/${offerId}`),
  })
}

export const useUoaBillingAutoTopUpSetup = () => {
  const apiClient = useApiClient()
  return useMutation<BillingHostedRedirectResponse, unknown, string>({
    mutationFn: (optionId) => apiClient.post(
      `/api/billing/credits/auto-top-up/options/${optionId}/setup`,
    ),
  })
}

export const useUoaBillingAutoTopUpSelect = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<void, unknown, string>({
    mutationFn: (optionId) => apiClient.post(
      `/api/billing/credits/auto-top-up/options/${optionId}/select`,
    ),
    onSuccess: () => invalidateFunding(queryClient),
  })
}

export const useUoaBillingAutoTopUpDisable = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<void>({
    mutationFn: () =>
      apiClient.post('/api/billing/credits/auto-top-up/disable'),
    onSuccess: () => invalidateFunding(queryClient),
  })
}

export const useUoaBillingAutoTopUpRecover = () => {
  const apiClient = useApiClient()
  return useMutation<BillingHostedRedirectResponse>({
    mutationFn: () =>
      apiClient.post('/api/billing/credits/auto-top-up/recover'),
  })
}

export const useUoaBillingRecurringAddonCheckout = () => {
  const apiClient = useApiClient()
  return useMutation<BillingHostedRedirectResponse, unknown, string>({
    mutationFn: (offerId) => apiClient.post(
      `/api/billing/recurring-addons/offers/${offerId}/subscribe`,
    ),
  })
}

export const useUoaBillingRecurringAddonCancellationPreview = () => {
  const apiClient = useApiClient()
  return useMutation<
    BillingRecurringAddonCancellationPreviewV1,
    unknown,
    string
  >({
    mutationFn: (subscriptionId) => apiClient.post(
      `/api/billing/recurring-addons/subscriptions/${subscriptionId}/cancellation/preview`,
    ),
  })
}

export const useUoaBillingRecurringAddonCancellationConfirm = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<
    BillingRecurringAddonCancellationConfirmationV1,
    unknown,
    {
      choice: 'cancel_addon'
      idempotency_key: string
      preview_token: string
    }
  >({
    mutationFn: (request) => apiClient.post(
      '/api/billing/recurring-addons/cancellation/confirm',
      request,
    ),
    onSuccess: () => invalidateFunding(queryClient),
  })
}

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
