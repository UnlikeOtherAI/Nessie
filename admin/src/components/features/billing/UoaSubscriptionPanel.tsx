import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  UoaBillingCheckoutResponse,
  UoaBillingPortalResponse,
  UoaBillingSubscriptionSummary,
} from '@nessie/schemas'
import { useApiClient } from '../../../providers/ApiClientProvider'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const titleCase = (value: string): string =>
  value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

const formatMinorMoney = (amountMinor: string, currency: string): string =>
  new Intl.NumberFormat('en-US', {
    currency,
    style: 'currency',
  }).format(Number(amountMinor) / 100)

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString() : 'Not available'

export const UoaSubscriptionPanel = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const summary = useQuery<UoaBillingSubscriptionSummary>({
    queryKey: ['uoa-billing-subscription'],
    queryFn: () => apiClient.get('/api/billing/subscription'),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  })

  const checkout = useMutation({
    mutationFn: () =>
      apiClient.post<UoaBillingCheckoutResponse>('/api/billing/checkout'),
    onSuccess: (response) => window.location.assign(response.checkout_url),
  })
  const portal = useMutation({
    mutationFn: () =>
      apiClient.post<UoaBillingPortalResponse>('/api/billing/portal'),
    onSuccess: (response) => window.location.assign(response.portal_url),
  })
  const cancel = useMutation({
    mutationFn: () =>
      apiClient.post<UoaBillingSubscriptionSummary>(
        '/api/billing/subscription/cancel',
      ),
    onSuccess: (response) => {
      queryClient.setQueryData(['uoa-billing-subscription'], response)
    },
  })

  const data = summary.data
  const actionError =
    checkout.error?.message ?? portal.error?.message ?? cancel.error?.message
  const pending = checkout.isPending || portal.isPending || cancel.isPending
  const canStart =
    data?.can_manage
    && data.stripe_collection_enabled
    && data.stripe_mode !== null
    && data.tariff.collection_mode === 'stripe'
    && data.tariff.payment_collection_enabled
    && !data.subscription

  return (
    <section className="mb-8">
      <div className={sectionTitle}>Subscription</div>
      <div className="mt-2 admin-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-[color:var(--tx)]">
              UnlikeOtherAI tariff and payment
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-[color:var(--tx2)]">
              Tariffs and subscriptions are owned by the shared SSO. Nessie
              receives only content-free entitlement and payment status.
            </p>
          </div>
          {data && (
            <div className="rounded-full border border-[color:var(--sep)] px-3 py-1 text-xs text-[color:var(--tx2)]">
              {data.stripe_collection_enabled && data.stripe_mode
                ? `${titleCase(data.stripe_mode)} payments`
                : 'Payments disabled'}
            </div>
          )}
        </div>

        {summary.isLoading && (
          <div className="mt-4 text-sm text-[color:var(--tx2)]">
            Loading subscription…
          </div>
        )}
        {summary.error && (
          <div className="mt-4 rounded-md border border-[var(--warning-soft)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning-text)]">
            Subscription management is unavailable: {summary.error.message}
          </div>
        )}
        {data && (
          <>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <div className={sectionTitle}>Tariff</div>
                <div className="mt-1 font-semibold text-[color:var(--tx)]">
                  {titleCase(data.tariff.key)} v{data.tariff.version}
                </div>
                <div className="mt-1 text-xs text-[color:var(--tx2)]">
                  {titleCase(data.assignment.scope)} assignment
                </div>
              </div>
              <div>
                <div className={sectionTitle}>Monthly</div>
                <div className="mt-1 font-semibold text-[color:var(--tx)]">
                  {formatMinorMoney(
                    data.tariff.monthly_subscription.amount_minor,
                    data.tariff.monthly_subscription.currency,
                  )}
                </div>
                <div className="mt-1 text-xs text-[color:var(--tx2)]">
                  {data.tariff.markup_percent}% added value on usage
                </div>
              </div>
              <div>
                <div className={sectionTitle}>Collection</div>
                <div className="mt-1 font-semibold text-[color:var(--tx)]">
                  {titleCase(data.tariff.collection_mode)}
                </div>
                <div className="mt-1 text-xs text-[color:var(--tx2)]">
                  {data.tariff.usage_billing_enabled
                    ? `${data.tariff.usage_price_multiplier_bps / 100}% billable-equivalent usage`
                    : 'Usage is free'}
                </div>
              </div>
              <div>
                <div className={sectionTitle}>Subscription status</div>
                <div className="mt-1 font-semibold text-[color:var(--tx)]">
                  {data.subscription
                    ? titleCase(data.subscription.status)
                    : 'No Stripe subscription'}
                </div>
                <div className="mt-1 text-xs text-[color:var(--tx2)]">
                  {data.subscription?.cancel_at_period_end
                    ? `Cancels ${formatDate(data.subscription.current_period_end)}`
                    : data.subscription?.billing_phase === 'free_alignment_period'
                      ? `Free alignment through ${formatDate(data.subscription.current_period_end)}`
                    : data.subscription
                      ? `Renews ${formatDate(data.subscription.current_period_end)}`
                      : data.tariff.payment_collection_enabled
                        ? data.tariff.collection_mode === 'manual'
                          ? 'Managed outside Stripe'
                          : 'Checkout has not been completed'
                        : 'No payment required'}
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {canStart && (
                <button
                  className="admin-button admin-button-primary"
                  disabled={pending}
                  onClick={() => checkout.mutate()}
                  type="button"
                >
                  {checkout.isPending ? 'Opening Checkout…' : 'Start subscription'}
                </button>
              )}
              {data.can_manage
                && data.stripe_collection_enabled
                && data.subscription && (
                <button
                  className="admin-button admin-button-secondary"
                  disabled={pending}
                  onClick={() => portal.mutate()}
                  type="button"
                >
                  {portal.isPending ? 'Opening Stripe…' : 'Manage in Stripe'}
                </button>
              )}
              {data.can_manage
                && data.stripe_collection_enabled
                && data.subscription
                && !data.subscription.cancel_at_period_end && (
                <button
                  className="admin-button admin-button-secondary"
                  disabled={pending}
                  onClick={() => {
                    if (
                      window.confirm(
                        'Cancel this subscription at the end of its current billing period?',
                      )
                    ) {
                      cancel.mutate()
                    }
                  }}
                  type="button"
                >
                  {cancel.isPending ? 'Scheduling…' : 'Cancel at period end'}
                </button>
              )}
            </div>
            {!data.can_manage && (
              <div className="mt-4 text-sm text-[color:var(--tx2)]">
                An organization or team billing manager must change this
                subscription.
              </div>
            )}
          </>
        )}
        {actionError && (
          <div className="mt-4 text-sm text-[color:var(--danger)]">
            {actionError}
          </div>
        )}
      </div>
    </section>
  )
}
