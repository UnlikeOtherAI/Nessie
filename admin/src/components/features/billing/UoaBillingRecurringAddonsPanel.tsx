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
import { SectionLabel } from '../../primitives/SectionLabel'
import { Card } from '../../shared/Card'
import { Dialog } from '../../shared/Dialog'
import { KeyValueList } from '../../shared/KeyValueList'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'

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
      <SectionLabel>Subscriptions &amp; add-ons</SectionLabel>
      <Card className="mt-2" variant="section">
        <QueryState
          errorLabel="Subscriptions and add-ons are unavailable."
          loadingLabel="Loading subscriptions and add-ons…"
          query={addons}
        >
          {() => data && (
            <>
              <div>
                <h2 className="text-lg font-semibold text-[color:var(--tx)]">
                  {data.title}
                </h2>
                <p className="mt-1 max-w-3xl text-sm text-[color:var(--tx2)]">
                  {data.description}
                </p>
              </div>
              <RowList className="mt-4" label="Subscriptions &amp; add-ons">
                {data.offers.map((offer) => (
                  <Row
                    key={offer.id}
                    subtitle={offer.description}
                    title={offer.name}
                    trailing={
                      <span className="text-sm font-semibold text-[color:var(--tx)]">
                        {offer.monthly_price.display}/month
                      </span>
                    }
                  >
                    <p className="mt-1 text-xs text-[color:var(--tx2)]">
                      {offer.entitlement.display_status} · {offer.entitlement.description}
                    </p>
                    {offer.benefits.length > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-[color:var(--tx2)]">
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
                              ? 'admin-button admin-button-primary admin-button-compact'
                              : 'admin-button admin-button-secondary admin-button-compact'}
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
                  </Row>
                ))}
              </RowList>
              {actionError && !preview && (
                <div className="mt-4 text-sm text-[color:var(--danger-text)]">
                  {actionError.message}
                </div>
              )}
            </>
          )}
        </QueryState>
      </Card>
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
  <Dialog
    dismissDisabled={pending}
    onClose={onClose}
    open
    title={confirmation?.title ?? preview.title}
  >
    <p className="text-sm text-[color:var(--tx2)]">
      {confirmation?.description ?? preview.description}
    </p>
    {!confirmation && (
      <KeyValueList
        className="mt-4"
        items={[
          { label: 'Offer', value: preview.subscription.offer_name },
          { label: 'Status', value: preview.subscription.display_status },
          {
            label: 'Ends',
            value: preview.subscription.cancellation_effective_at
              ? new Date(preview.subscription.cancellation_effective_at).toLocaleString()
              : 'At the current billing period boundary',
          },
        ]}
      />
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
  </Dialog>
)
