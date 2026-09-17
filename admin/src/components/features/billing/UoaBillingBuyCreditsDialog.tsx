import { useState } from 'react'
import type { BillingCreditsManagerV1 } from '@unlikeotherai/billing-statement-protocol'

import { useUoaBillingCreditTopUp } from '../../../facades/billing/hooks'
import { Dialog } from '../../shared/Dialog'

/**
 * The prototype's "Buy credits" modal, mapped onto the real funding offers
 * and the real `useUoaBillingCreditTopUp()` redirect — moved out of
 * `UoaBillingCreditsPanel`'s always-open section into a modal the balance
 * row's "Buy credits" button opens, matching the prototype's interaction.
 */
export const UoaBillingBuyCreditsDialog = ({
  credits,
  onClose,
  open,
}: {
  credits: BillingCreditsManagerV1
  onClose: () => void
  open: boolean
}) => {
  const topUp = useUoaBillingCreditTopUp()
  const offers = credits.funding_policy.offers
  const [selectedId, setSelectedId] = useState(offers[0]?.id)
  const selected = offers.find((offer) => offer.id === selectedId) ?? offers[0]

  return (
    <Dialog
      description={credits.funding_policy.description}
      dismissDisabled={topUp.isPending}
      onClose={onClose}
      open={open}
      title={credits.funding_policy.title}
    >
      <div className="grid gap-2">
        {offers.map((offer) => (
          <button
            className={[
              'flex items-center justify-between rounded-xl border p-3 text-left transition-colors',
              offer.id === selectedId
                ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]'
                : 'border-[color:var(--sep)] hover:bg-[color:var(--overlay-weak)]',
              !offer.available ? 'cursor-not-allowed opacity-50' : '',
            ].join(' ')}
            disabled={!offer.available}
            key={offer.id}
            onClick={() => setSelectedId(offer.id)}
            title={offer.unavailable_reason ?? offer.description}
            type="button"
          >
            <span className="flex items-center gap-3">
              <span
                className={[
                  'inline-block h-[18px] w-[18px] rounded-full border-[1.5px]',
                  offer.id === selectedId
                    ? 'border-[6px] border-[color:var(--accent)]'
                    : 'border-[color:var(--tx3)]',
                ].join(' ')}
              />
              <span className="text-sm font-medium text-[color:var(--tx)]">
                {offer.name}
              </span>
            </span>
            <span className="text-sm text-[color:var(--tx2)]">
              {offer.payment_amount.display}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-5 flex gap-2">
        <button
          className="admin-button admin-button-primary flex-1"
          disabled={!selected || !selected.action.enabled || topUp.isPending}
          onClick={() => {
            if (!selected) return
            topUp.mutate(selected.id, {
              onSuccess: (result) => {
                window.location.assign(result.redirect_url)
              },
            })
          }}
          title={selected?.action.disabled_reason ?? selected?.action.description}
          type="button"
        >
          {topUp.isPending
            ? 'Redirecting…'
            : selected
              ? `Buy ${selected.credits_received.display}`
              : credits.funding_policy.title}
        </button>
      </div>

      {topUp.error instanceof Error && (
        <div className="mt-3 text-xs text-[color:var(--danger-text)]">
          {topUp.error.message}
        </div>
      )}
    </Dialog>
  )
}
