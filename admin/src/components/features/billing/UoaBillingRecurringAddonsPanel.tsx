import { useState } from 'react'
import type {
  BillingRecurringAddonCancellationConfirmationV1,
  BillingRecurringAddonCancellationPreviewV1,
} from '@unlikeotherai/billing-statement-protocol'

import {
  useUoaBillingRecurringAddonCancellationConfirm,
  useUoaBillingRecurringAddonCancellationPreview,
  useUoaBillingRecurringAddonCheckout,
  useUoaBillingRecurringAddons,
} from '../../../facades/billing/hooks'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const UoaBillingRecurringAddonsPanel = () => {
  const addons = useUoaBillingRecurringAddons()
  const checkout = useUoaBillingRecurringAddonCheckout()
  const cancellationPreview = useUoaBillingRecurringAddonCancellationPreview()
  const cancellationConfirm = useUoaBillingRecurringAddonCancellationConfirm()
  const [preview, setPreview] =
    useState<BillingRecurringAddonCancellationPreviewV1 | null>(null)
  const [confirmation, setConfirmation] =
    useState<BillingRecurringAddonCancellationConfirmationV1 | null>(null)
  const data = addons.data
  const actionPending = checkout.isPending
    || cancellationPreview.isPending
    || cancellationConfirm.isPending
  const actionError = [
    checkout.error,
    cancellationPreview.error,
    cancellationConfirm.error,
  ].find((value): value is Error => value instanceof Error)

  if (!addons.isLoading && !addons.error && data?.offers.length === 0) {
    return null
  }

  return (
    <section className="mb-8" data-testid="uoa-billing-recurring-addons">
      <div className={sectionTitle}>Subscriptions &amp; add-ons</div>
      <div className="mt-2 admin-card p-5">
        {addons.isLoading && (
          <div className="text-sm text-[color:var(--tx2)]">
            Loading subscriptions and add-ons…
          </div>
        )}
        {addons.error && (
          <div className="rounded-md border border-[var(--warning-soft)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning-text)]">
            Subscriptions and add-ons are unavailable: {addons.error.message}
          </div>
        )}
        {data && (
          <>
            <div>
              <h2 className="text-lg font-semibold text-[color:var(--tx)]">
                {data.title}
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-[color:var(--tx2)]">
                {data.description}
              </p>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {data.offers.map((offer) => (
                <article
                  className="rounded-lg border border-[color:var(--sep)] p-4"
                  key={offer.id}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold text-[color:var(--tx)]">
                        {offer.name}
                      </div>
                      <div className="mt-1 text-xs text-[color:var(--tx2)]">
                        {offer.description}
                      </div>
                    </div>
                    <div className="shrink-0 text-sm font-semibold text-[color:var(--tx)]">
                      {offer.monthly_price.display}/month
                    </div>
                  </div>
                  <div className="mt-3 rounded-md bg-[color:var(--overlay-weak)] p-2 text-xs text-[color:var(--tx2)]">
                    {offer.entitlement.display_status} · {offer.entitlement.description}
                  </div>
                  {offer.benefits.length > 0 && (
                    <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-[color:var(--tx2)]">
                      {offer.benefits.map((benefit) => (
                        <li key={benefit}>{benefit}</li>
                      ))}
                    </ul>
                  )}
                  {data.viewer.role === 'billing_manager' && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {offer.actions.map((action) => (
                        <button
                          className={action.id === 'subscribe'
                            ? 'admin-button admin-button-primary text-xs'
                            : 'admin-button admin-button-secondary text-xs'}
                          disabled={!action.enabled || actionPending}
                          key={action.id}
                          onClick={() => {
                            if (action.id === 'subscribe') {
                              checkout.mutate(offer.id, {
                                onSuccess: (result) => {
                                  window.location.assign(result.redirect_url)
                                },
                              })
                              return
                            }
                            cancellationPreview.mutate(
                              action.request.body.subscription_id,
                              {
                                onSuccess: (result) => {
                                  setConfirmation(null)
                                  setPreview(result)
                                },
                              },
                            )
                          }}
                          title={action.disabled_reason ?? action.description}
                          type="button"
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
            {actionError && !preview && (
              <div className="mt-4 text-sm text-[color:var(--danger-text)]">
                {actionError.message}
              </div>
            )}
          </>
        )}
      </div>
      {preview && (
        <AddonCancellationDialog
          confirmation={confirmation}
          error={actionError?.message ?? null}
          onClose={() => {
            if (cancellationConfirm.isPending) return
            setPreview(null)
            setConfirmation(null)
            cancellationConfirm.reset()
          }}
          onConfirm={() => {
            cancellationConfirm.mutate(
              {
                choice: 'cancel_addon',
                idempotency_key: preview.idempotency_key,
                preview_token: preview.preview_token,
              },
              { onSuccess: setConfirmation },
            )
          }}
          pending={cancellationConfirm.isPending}
          preview={preview}
        />
      )}
    </section>
  )
}

const AddonCancellationDialog = ({
  confirmation,
  error,
  onClose,
  onConfirm,
  pending,
  preview,
}: {
  confirmation: BillingRecurringAddonCancellationConfirmationV1 | null
  error: string | null
  onClose: () => void
  onConfirm: () => void
  pending: boolean
  preview: BillingRecurringAddonCancellationPreviewV1
}) => (
  <div
    aria-labelledby="uoa-addon-cancellation-title"
    aria-modal="true"
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
  >
    <div className="admin-card w-full max-w-lg p-5">
      <h2
        className="text-lg font-semibold text-[color:var(--tx)]"
        id="uoa-addon-cancellation-title"
      >
        {confirmation?.title ?? preview.title}
      </h2>
      <p className="mt-2 text-sm text-[color:var(--tx2)]">
        {confirmation?.description ?? preview.description}
      </p>
      {!confirmation && (
        <div className="mt-4 rounded-lg border border-[color:var(--sep)] p-3 text-sm text-[color:var(--tx2)]">
          <div className="font-semibold text-[color:var(--tx)]">
            {preview.subscription.offer_name}
          </div>
          <div className="mt-1">{preview.subscription.display_status}</div>
          <div className="mt-1">
            Ends: {preview.subscription.cancellation_effective_at
              ? new Date(
                preview.subscription.cancellation_effective_at,
              ).toLocaleString()
              : 'At the current billing period boundary'}
          </div>
        </div>
      )}
      {error && (
        <div className="mt-3 text-sm text-[color:var(--danger-text)]">
          {error}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          className="admin-button admin-button-secondary"
          disabled={pending}
          onClick={onClose}
          type="button"
        >
          {confirmation ? 'Close' : 'Keep add-on'}
        </button>
        {!confirmation && (
          <button
            className="admin-button admin-button-primary"
            disabled={pending}
            onClick={onConfirm}
            type="button"
          >
            {pending ? 'Confirming…' : 'Confirm cancellation'}
          </button>
        )}
      </div>
    </div>
  </div>
)
