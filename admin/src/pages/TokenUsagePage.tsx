import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { UoaBillingCreditsPanel } from '../components/features/billing/UoaBillingCreditsPanel'
import { UoaBillingRecurringAddonsPanel } from '../components/features/billing/UoaBillingRecurringAddonsPanel'
import {
  UoaBillingPlanSummary,
  UoaBillingStatementPanel,
} from '../components/features/billing/UoaBillingStatementPanel'
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
  // The prototype's two-view navigation ("Usage & billing" ↔ "Statement")
  // mapped onto this one route: both views read the same real queries, this
  // just changes which panels are on screen.
  const [view, setView] = useState<'statement' | 'usage'>('usage')
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
      <ScreenHeader
        flowOwnsBack={view === 'statement'}
        onBack={view === 'statement' ? () => setView('usage') : undefined}
        title={view === 'statement' ? 'Statement' : 'Credits & Billing'}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-10 py-9">
        {/* The prototype reads as a single dense column, not the admin's
            usual edge-to-edge body — this page caps its own content width
            rather than using the shared full-width `PageBody`. */}
        <div className="mx-auto grid w-full max-w-[1040px] gap-8">
          {checkoutNotice && (
            <div data-testid="uoa-billing-checkout-return">
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
          {view === 'usage' ? (
            <>
              <UoaBillingCreditsPanel
                onViewStatement={canReadStatement ? () => setView('statement') : undefined}
              />
              {canReadStatement && <UoaBillingPlanSummary />}
              <UoaBillingRecurringAddonsPanel />
            </>
          ) : (
            canReadStatement && <UoaBillingStatementPanel />
          )}
        </div>
      </div>
    </section>
  )
}
