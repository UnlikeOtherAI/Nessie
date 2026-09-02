import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { UoaBillingCreditsPanel } from '../components/features/billing/UoaBillingCreditsPanel'
import { UoaBillingRecurringAddonsPanel } from '../components/features/billing/UoaBillingRecurringAddonsPanel'
import { UoaBillingStatementPanel } from '../components/features/billing/UoaBillingStatementPanel'
import { Notice } from '../components/primitives/Notice'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import {
  getUoaBillingCheckoutReturnNotice,
  parseUoaBillingCheckoutReturn,
  UOA_BILLING_CHECKOUT_RETURN_PARAMETER,
} from '../facades/billing/checkout-return'
import {
  billingCreditsKey,
  billingRecurringAddonsKey,
  billingStatementKey,
  useUoaBillingCapability,
} from '../facades/billing/hooks'
import { useConsumedIntent } from '../navigation/intent'
import { useAuthSession } from '../providers/AuthSessionProvider'

export const TokenUsagePage = () => {
  const { me } = useAuthSession()
  const billingCapability = useUoaBillingCapability()
  const queryClient = useQueryClient()
  const refreshedCheckoutSerial = useRef(0)
  const canReadStatement = billingCapability.data?.canReadStatement === true
  // UOA sends the person back here with the outcome; it is a consumed intent
  // (docs/navigation/overview.md §8), so the notice shows for this visit and a
  // refresh or Back lands on plain /tokens without re-announcing it.
  const checkoutIntent = useConsumedIntent(UOA_BILLING_CHECKOUT_RETURN_PARAMETER)
  const checkoutReturn = parseUoaBillingCheckoutReturn(checkoutIntent.value)
  const checkoutNotice = checkoutReturn
    ? getUoaBillingCheckoutReturnNotice(checkoutReturn)
    : null

  useEffect(() => {
    if (
      !checkoutReturn
      || refreshedCheckoutSerial.current === checkoutIntent.serial
    ) {
      return
    }
    refreshedCheckoutSerial.current = checkoutIntent.serial
    const scope = billingCapability.data?.scope
    if (!scope) return
    for (const queryKey of [
      billingCreditsKey(scope),
      billingRecurringAddonsKey(scope),
      ...(canReadStatement ? [billingStatementKey(scope)] : []),
    ]) {
      void queryClient.refetchQueries({
        exact: true,
        queryKey,
        type: 'all',
      })
    }
  }, [billingCapability.data?.scope, canReadStatement, checkoutIntent.serial, checkoutReturn, queryClient])

  if (!me) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Sign in to view team credits
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader title="Credits & Billing" />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {checkoutNotice && (
          <div className="mb-4" data-testid="uoa-billing-checkout-return">
            <Notice padding="lg" role="status" tone="info">
              <div className="font-semibold text-[color:var(--tx)]">
                {checkoutNotice.title}
              </div>
              <p className="mt-1 text-sm">
                {checkoutNotice.message}
              </p>
            </Notice>
          </div>
        )}
        <UoaBillingCreditsPanel />
        <UoaBillingRecurringAddonsPanel />
        {canReadStatement && <UoaBillingStatementPanel />}
      </div>
    </section>
  )
}
