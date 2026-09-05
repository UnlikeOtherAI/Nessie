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
import { formErrorMessage } from '../../../facades/form-errors'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { Card } from '../../shared/Card'
import { QueryState } from '../../shared/QueryState'
import { StatGrid, StatTile } from '../../shared/StatTile'
import { UoaBillingCancellationDialog } from './UoaBillingCancellationDialog'
import { UoaBillingStatementDetails } from './UoaBillingStatementDetails'

const BILLING_ACTION_FALLBACK = 'Something went wrong. Try again.'

// A mutation with no error carries `null`, not the fallback sentence — the
// panel only renders an error block when there is one to show.
const mutationErrorMessage = (error: unknown): string | null =>
  error ? formErrorMessage(error, BILLING_ACTION_FALLBACK) : null

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
    mutationErrorMessage(hostedAction.error)
    ?? mutationErrorMessage(previewAction.error)
  const actionPending =
    hostedAction.isPending
    || previewAction.isPending
    || confirmationPending

  return (
    <section className="mb-8" data-testid="uoa-billing-statement">
      <SectionLabel>Customer statement</SectionLabel>
      <Card className="mt-2" variant="section">
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
          {data && (
            <Pill tone="outline">
              {data.period.key} · {data.period.state}
            </Pill>
          )}
        </div>

        <QueryState
          className="mt-4 py-6"
          errorLabel="Billing is unavailable."
          loadingLabel="Loading customer statement…"
          query={statement}
        >
          {() => data && (
            <>
              <StatGrid className="mt-5 sm:grid-cols-2 xl:grid-cols-4">
                <StatTile
                  detail={data.plan.markup_display}
                  label="Plan"
                  value={data.plan.display_name}
                />
                <StatTile
                  detail={`${data.plan.assignment.scope} assignment`}
                  label="Monthly"
                  value={data.plan.monthly_subscription.display}
                />
                <StatTile
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
                <StatTile
                  detail="Subscription, usage, add-ons, and credits"
                  label="Total due"
                  value={
                    data.totals.length === 1
                      ? data.totals[0]?.total_due.display ?? 'Unavailable'
                      : `${data.totals.length} currency totals`
                  }
                />
              </StatGrid>

              {data.totals.length > 0 && (
                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {data.totals.map((total) => (
                    <li
                      className="rounded-md bg-[color:var(--overlay-weak)] p-3 text-xs text-[color:var(--tx2)]"
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
                    </li>
                  ))}
                </ul>
              )}

              <UoaBillingStatementDetails statement={data} />

              <div className="mt-6">
                <SectionLabel>Subscription actions</SectionLabel>
                <ul className="mt-2 divide-y divide-[color:var(--sep)]">
                  {data.actions.map((action) => (
                    <li className="flex flex-wrap items-center gap-3 py-2.5" key={action.id}>
                      <button
                        className={actionButtonClass(action)}
                        data-testid={`uoa-billing-action-${action.id}`}
                        disabled={!action.enabled || actionPending}
                        onClick={() => {
                          void runAction(action)
                        }}
                        type="button"
                      >
                        {action.label}
                      </button>
                      <div className="min-w-0 flex-1 text-xs text-[color:var(--tx2)]">
                        {action.description}
                        {!action.enabled && action.disabled_reason && (
                          <div className="mt-0.5 text-[color:var(--tx3)]">
                            {action.disabled_reason}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </QueryState>

        {actionError && (
          <div className="mt-4 text-sm text-[color:var(--danger-text)]">
            {actionError}
          </div>
        )}
      </Card>

      {(preview || confirmation) && (
        <UoaBillingCancellationDialog
          confirmation={confirmation}
          error={mutationErrorMessage(confirmAction.error)}
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
