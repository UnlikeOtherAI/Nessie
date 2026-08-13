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
import type { MeResponse, UoaBillingCapability } from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useOptionalAuthSession } from '../../providers/AuthSessionProvider'

type BillingSessionScope = {
  organizationId: string
  sessionId: string
  teamId: string
  userId: string
}

const billingSessionScope = (
  me: MeResponse | null,
): BillingSessionScope | null => me ? {
  organizationId: me.context.organizationId,
  sessionId: me.session.sessionId,
  teamId: me.context.teamId,
  userId: me.user.id,
} : null

export const billingCapabilityKey = (scope: BillingSessionScope | null) => [
  'uoa-billing-capability',
  scope?.userId ?? 'anonymous',
  scope?.organizationId ?? 'no-organization',
  scope?.teamId ?? 'no-team',
  scope?.sessionId ?? 'no-session',
] as const

export const billingCreditsKey = (scope: UoaBillingCapability['scope']) => [
  'uoa-billing-credits',
  scope.userId,
  scope.organisationId,
  scope.teamId,
  scope.tokenVersion,
] as const

export const billingRecurringAddonsKey = (
  scope: UoaBillingCapability['scope'],
) => [
  'uoa-billing-recurring-addons',
  scope.userId,
  scope.organisationId,
  scope.teamId,
  scope.tokenVersion,
] as const

export const billingStatementKey = (scope: UoaBillingCapability['scope']) => [
  'uoa-billing-statement',
  scope.userId,
  scope.organisationId,
  scope.teamId,
  scope.tokenVersion,
] as const

/**
 * Fetches UOA's role projection before any billing data. Its result is part of
 * every billing cache key, preventing one team's manager projection from being
 * reused after another active-team switch.
 */
export const useUoaBillingCapability = () => {
  const apiClient = useApiClient()
  const session = useOptionalAuthSession()
  const scope = billingSessionScope(session?.me ?? null)
  return useQuery<UoaBillingCapability>({
    enabled: scope !== null,
    queryKey: billingCapabilityKey(scope),
    queryFn: () => apiClient.get('/api/billing/capability'),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 0,
  })
}

export const useUoaBillingCredits = () => {
  const apiClient = useApiClient()
  const capability = useUoaBillingCapability()
  return useQuery<BillingCreditsV1>({
    enabled: capability.data !== undefined,
    queryKey: billingCreditsKey(capability.data?.scope ?? {
      organisationId: 'pending', teamId: 'pending', tokenVersion: -1, userId: 'pending',
    }),
    queryFn: () => apiClient.get('/api/billing/credits'),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 0,
  })
}

export const useUoaBillingRecurringAddons = () => {
  const apiClient = useApiClient()
  const capability = useUoaBillingCapability()
  return useQuery<BillingRecurringAddonsV1>({
    enabled: capability.data !== undefined,
    queryKey: billingRecurringAddonsKey(capability.data?.scope ?? {
      organisationId: 'pending', teamId: 'pending', tokenVersion: -1, userId: 'pending',
    }),
    queryFn: () => apiClient.get('/api/billing/recurring-addons'),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 0,
  })
}

const invalidateFunding = (
  queryClient: ReturnType<typeof useQueryClient>,
): void => {
  void queryClient.invalidateQueries({ queryKey: ['uoa-billing-credits'] })
  void queryClient.invalidateQueries({ queryKey: ['uoa-billing-recurring-addons'] })
  void queryClient.invalidateQueries({ queryKey: ['uoa-billing-statement'] })
  void queryClient.invalidateQueries({ queryKey: ['uoa-billing-capability'] })
}

export const useUoaBillingCreditTopUp = () => {
  const apiClient = useApiClient()
  return useMutation<BillingHostedRedirectResponse, unknown, string>({
    mutationFn: (offerId) => apiClient.post(`/api/billing/credits/top-ups/${offerId}`),
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
    mutationFn: () => apiClient.post('/api/billing/credits/auto-top-up/disable'),
    onSuccess: () => invalidateFunding(queryClient),
  })
}

export const useUoaBillingAutoTopUpRecover = () => {
  const apiClient = useApiClient()
  return useMutation<BillingHostedRedirectResponse>({
    mutationFn: () => apiClient.post('/api/billing/credits/auto-top-up/recover'),
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
  return useMutation<BillingRecurringAddonCancellationPreviewV1, unknown, string>({
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
    { choice: 'cancel_addon'; idempotency_key: string; preview_token: string }
  >({
    mutationFn: (request) => apiClient.post(
      '/api/billing/recurring-addons/cancellation/confirm', request,
    ),
    onSuccess: () => invalidateFunding(queryClient),
  })
}

export const useUoaBillingStatement = () => {
  const apiClient = useApiClient()
  const capability = useUoaBillingCapability()
  return useQuery<BillingStatementV2>({
    enabled: capability.data?.canReadStatement === true,
    queryKey: billingStatementKey(capability.data?.scope ?? {
      organisationId: 'pending', teamId: 'pending', tokenVersion: -1, userId: 'pending',
    }),
    queryFn: () => apiClient.get('/api/billing/statement'),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 0,
  })
}

export const useUoaBillingHostedAction = () => {
  const apiClient = useApiClient()
  return useMutation<BillingHostedRedirectResponse, unknown, 'portal' | 'upgrade'>({
    mutationFn: (id) => apiClient.post(`/api/billing/actions/${id}`),
  })
}

export const useUoaBillingCancellationPreview = () => {
  const apiClient = useApiClient()
  return useMutation<BillingCancellationPreviewV1>({
    mutationFn: () => apiClient.post('/api/billing/cancellation/preview'),
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
    mutationFn: (request) => apiClient.post('/api/billing/cancellation/confirm', request),
    onSuccess: () => invalidateFunding(queryClient),
  })
}
