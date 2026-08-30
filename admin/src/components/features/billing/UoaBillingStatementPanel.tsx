import {
  useCallback,
  useState,
} from 'react'
import type {
  BillingCancellationConfirmationV1,
  BillingCancellationPreviewV1,
  BillingCancellationSelection,
  BillingStatementAction,
} from '@unlikeotherai/billing-statement-protocol'
import {
  useUoaBillingCancellationConfirm,
  useUoaBillingCancellationPreview,
  useUoaBillingHostedAction,
  useUoaBillingStatement,
} from '../../../facades/billing/hooks'
import { SectionLabel } from '../../primitives/SectionLabel'
import { UoaBillingCancellationDialog } from './UoaBillingCancellationDialog'
import { UoaBillingStatementDetails } from './UoaBillingStatementDetails'

const errorMessage = (error: unknown): string | null =>
  error instanceof Error ? error.message : null

const SummaryCard = ({
  detail,
  label,
  value,
}: {
  detail: string
  label: string
  value: string
}) => (
  <div className="rounded-lg border border-[color:var(--sep)] p-3">
    <SectionLabel>{label}</SectionLabel>
    <div className="mt-1 font-semibold text-[color:var(--tx)]">
      {value}
    </div>
    <div className="mt-1 text-xs text-[color:var(--tx2)]">
      {detail}
    </div>
  </div>
)

const actionButtonClass = (
  action: BillingStatementAction,
): string =>
  action.id === 'upgrade'
    ? 'admin-button admin-button-primary'
    : 'admin-button admin-button-secondary'

export const UoaBillingStatementPanel = () => {
  const statement = useUoaBillingStatement()
  const hostedAction = useUoaBillingHostedAction()
  const previewAction = useUoaBillingCancellationPreview()
  const confirmAction = useUoaBillingCancellationConfirm()
  const [preview, setPreview] =
    useState<BillingCancellationPreviewV1 | null>(null)
  const [confirmation, setConfirmation] =
    useState<BillingCancellationConfirmationV1 | null>(null)
  const confirmationPending = confirmAction.isPending
  const resetConfirmation = confirmAction.reset

  const closeDialog = useCallback(() => {
    if (confirmationPending) return
    setPreview(null)
    setConfirmation(null)
    resetConfirmation()
  }, [confirmationPending, resetConfirmation])

  const runAction = async (action: BillingStatementAction) => {
    if (!action.enabled) return
    if (action.id === 'cancel') {
      const result = await previewAction.mutateAsync()
      setConfirmation(null)
      setPreview(result)
      return
    }
    const result = await hostedAction.mutateAsync(action.id)
    window.location.assign(result.redirect_url)
  }

  const confirmCancellation = async (
    selection: BillingCancellationSelection | null,
  ) => {
    if (!preview) return
    const result = await confirmAction.mutateAsync({
      preview_token: preview.preview_token,
      idempotency_key: preview.confirm_action.idempotency_key,
      selection,
    })
    setConfirmation(result)
  }

  const data = statement.data
  const actionError =
    errorMessage(hostedAction.error)
    ?? errorMessage(previewAction.error)
  const actionPending =
    hostedAction.isPending
    || previewAction.isPending
    || confirmationPending

  return (
    <section className="mb-8" data-testid="uoa-billing-statement">
      <SectionLabel>Customer statement</SectionLabel>
      <div className="mt-2 admin-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-[color:var(--tx)]">
              UnlikeOtherAI billing
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-[color:var(--tx2)]">
              SSO supplies this complete statement, including plan terms,
              usage rating, service attribution, line items, and actions.
              Nessie does not calculate commercial billing.
            </p>
          </div>
          {/* Unconverted: border-only chip; Pill bordered+muted adds an --overlay-weak fill. */}
          {data && (
            <div className="rounded-full border border-[color:var(--sep)] px-3 py-1 text-xs text-[color:var(--tx2)]">
              {data.period.key} · {data.period.state}
            </div>
          )}
        </div>

        {statement.isLoading && (
          <div className="mt-4 text-sm text-[color:var(--tx2)]">
            Loading customer statement…
          </div>
        )}
        {/* Unconverted: the border deliberately matches the fill (both --warning-soft), so no outline shows. */}
        {statement.error && (
          <div className="mt-4 rounded-md border border-[var(--warning-soft)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning-text)]">
            Billing is unavailable: {statement.error.message}
          </div>
        )}

        {data && (
          <>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryCard
                detail={data.plan.markup_display}
                label="Plan"
                value={data.plan.display_name}
              />
              <SummaryCard
                detail={`${data.plan.assignment.scope} assignment`}
                label="Monthly"
                value={data.plan.monthly_subscription.display}
              />
              <SummaryCard
                detail={
                  data.subscription?.cancel_at_period_end
                    ? 'Cancellation is scheduled'
                    : data.subscription
                      ? 'Subscription managed by SSO'
                      : 'No direct subscription'
                }
                label="Subscription"
                value={data.subscription?.display_status ?? 'Not subscribed'}
              />
              <SummaryCard
                detail="Subscription, usage, add-ons, and credits"
                label="Total due"
                value={
                  data.totals.length === 1
                    ? data.totals[0]?.total_due.display ?? 'Unavailable'
                    : `${data.totals.length} currency totals`
                }
              />
            </div>

            {data.totals.length > 0 && (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {data.totals.map((total) => (
                  <div
                    className="rounded-lg bg-[color:var(--overlay-weak)] p-3 text-xs text-[color:var(--tx2)]"
                    key={total.currency}
                  >
                    <div className="font-semibold text-[color:var(--tx)]">
                      {total.total_due.display} due
                    </div>
                    <div className="mt-1">
                      Monthly {total.monthly.display} · Usage{' '}
                      {total.usage.display} · Add-ons {total.add_ons.display} ·
                      Credits {total.credits.display}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <UoaBillingStatementDetails statement={data} />

            <div className="mt-6">
              <SectionLabel>Subscription actions</SectionLabel>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {data.actions.map((action) => (
                  <div
                    className="rounded-lg border border-[color:var(--sep)] p-3"
                    key={action.id}
                  >
                    <button
                      className={`${actionButtonClass(action)} w-full`}
                      data-testid={`uoa-billing-action-${action.id}`}
                      disabled={!action.enabled || actionPending}
                      onClick={() => {
                        void runAction(action)
                      }}
                      type="button"
                    >
                      {action.label}
                    </button>
                    <div className="mt-2 text-xs text-[color:var(--tx2)]">
                      {action.description}
                    </div>
                    {!action.enabled && action.disabled_reason && (
                      <div className="mt-1 text-xs text-[color:var(--tx3)]">
                        {action.disabled_reason}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {actionError && (
          <div className="mt-4 text-sm text-[color:var(--danger-text)]">
            {actionError}
          </div>
        )}
      </div>

      {(preview || confirmation) && (
        <UoaBillingCancellationDialog
          confirmation={confirmation}
          error={errorMessage(confirmAction.error)}
          onClose={closeDialog}
          onConfirm={(selection) => {
            void confirmCancellation(selection)
          }}
          pending={confirmationPending}
          preview={preview}
        />
      )}
    </section>
  )
}
