import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { UoaBillingCreditsPanel } from '../components/features/billing/UoaBillingCreditsPanel'
import { UoaBillingRecurringAddonsPanel } from '../components/features/billing/UoaBillingRecurringAddonsPanel'
import { UoaBillingStatementPanel } from '../components/features/billing/UoaBillingStatementPanel'
import {
  getUoaBillingCheckoutReturnNotice,
  readUoaBillingCheckoutReturn,
} from '../facades/billing/checkout-return'
import {
  billingCreditsKey,
  billingRecurringAddonsKey,
  billingStatementKey,
} from '../facades/billing/hooks'
import { MobileMenuButton } from '../layouts/admin-shell/MobileMenuButton'
import { useAuthSession } from '../providers/AuthSessionProvider'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const TokenUsagePage = () => {
  const { me } = useAuthSession()
  const location = useLocation()
  const queryClient = useQueryClient()
  const refreshedCheckoutLocation = useRef<string | null>(null)
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const canReadStatement =
    isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const checkoutReturn = readUoaBillingCheckoutReturn(location.search)
  const checkoutNotice = checkoutReturn
    ? getUoaBillingCheckoutReturnNotice(checkoutReturn)
    : null

  useEffect(() => {
    if (
      !checkoutReturn
      || refreshedCheckoutLocation.current === location.key
    ) {
      return
    }
    refreshedCheckoutLocation.current = location.key
    for (const queryKey of [
      billingCreditsKey,
      billingRecurringAddonsKey,
      ...(canReadStatement ? [billingStatementKey] : []),
    ]) {
      void queryClient.refetchQueries({
        exact: true,
        queryKey,
        type: 'all',
      })
    }
  }, [canReadStatement, checkoutReturn, location.key, queryClient])

  if (!me) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Sign in to view team credits
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-4 border-b border-[color:var(--sep)] px-5">
        <MobileMenuButton />
        <div className={sectionTitle}>Credits &amp; Billing</div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {checkoutNotice && (
          <div
            className="admin-card mb-4 border border-[color:var(--sep)] p-4"
            data-testid="uoa-billing-checkout-return"
            role="status"
          >
            <div className="font-semibold text-[color:var(--tx)]">
              {checkoutNotice.title}
            </div>
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              {checkoutNotice.message}
            </p>
          </div>
        )}
        <UoaBillingCreditsPanel />
        <UoaBillingRecurringAddonsPanel />
        {canReadStatement && <UoaBillingStatementPanel />}
      </div>
    </section>
  )
}
