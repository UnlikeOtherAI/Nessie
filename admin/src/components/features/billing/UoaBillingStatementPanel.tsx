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
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { Pill } from '../../primitives/Pill'
import { QueryState } from '../../shared/QueryState'
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
    ? 'admin-button admin-button-primary admin-button-compact'
    : 'admin-button admin-button-secondary admin-button-compact'

/**
 * The prototype's "Your plan" box, on the usage view. Reads the same
 * `useUoaBillingStatement()` query `UoaBillingStatementPanel` uses (same
 * cache key, so switching between the usage and statement views never
 * double-fetches) — "Compare plans" and "Upgrade plan" both run the real
 * `upgrade` hosted action; there is no separate in-app plan-comparison
 * screen to route "Compare plans" to.
 */
export const UoaBillingPlanSummary = () => {
  const statement = useUoaBillingStatement()
  const hostedAction = useUoaBillingHostedAction()
  const data = statement.data
  const upgrade = data?.actions.find((action) => action.id === 'upgrade')

  if (statement.isLoading || statement.isError || !data) return null

  const runUpgrade = () => {
    if (!upgrade?.enabled) return
    hostedAction.mutate('upgrade', {
      onSuccess: (result) => {
        window.location.assign(result.redirect_url)
      },
    })
  }

  return (
    <section data-testid="uoa-billing-plan-summary">
      <h2 className="mb-3.5 text-[17px] font-semibold text-[color:var(--tx)]">Your plan</h2>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-[color:var(--overlay-weak)] px-6 py-5">
        <div>
          <div className="text-xl font-semibold tracking-tight text-[color:var(--tx)]">
            {data.plan.display_name}
          </div>
          <div className="mt-1 text-[color:var(--tx2)]">
            {data.plan.monthly_subscription.display}/mo · {data.plan.markup_display} markup ·
            credits and subscriptions billed separately
          </div>
        </div>
        {upgrade && (
          <div className="flex flex-none items-center gap-3">
            <button
              className="text-sm text-[color:var(--tx2)] hover:text-[color:var(--tx)]"
              disabled={!upgrade.enabled || hostedAction.isPending}
              onClick={runUpgrade}
              title={upgrade.disabled_reason ?? undefined}
              type="button"
            >
              Compare plans
            </button>
            <button
              className="admin-button admin-button-primary"
              disabled={!upgrade.enabled || hostedAction.isPending}
              onClick={runUpgrade}
              title={upgrade.disabled_reason ?? undefined}
              type="button"
            >
              {upgrade.label}
            </button>
          </div>
        )}
      </div>
      {hostedAction.error instanceof Error && (
        <div className="mt-3 text-xs text-[color:var(--danger-text)]">
          {hostedAction.error.message}
        </div>
      )}
    </section>
  )
}

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
  const primaryTotal = data && data.totals.length === 1 ? data.totals[0] : null

  return (
    <section data-testid="uoa-billing-statement" className="grid gap-8">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-2xl text-[color:var(--tx2)]">
            UnlikeOtherAI billing (SSO) supplies this complete statement — plan terms, usage
            rating, service attribution, line items, and actions. Nessie does not calculate
            commercial billing.
          </p>
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
              <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="text-[color:var(--tx2)]">Total due</div>
                  <div className="mt-1 text-[36px] font-semibold tracking-tight text-[color:var(--tx)]">
                    {primaryTotal?.total_due.display
                      ?? (data.totals.length > 0 ? `${data.totals.length} currency totals` : 'Unavailable')}
                  </div>
                </div>
                {primaryTotal && (
                  <div className="text-right text-sm text-[color:var(--tx2)]">
                    Monthly {primaryTotal.monthly.display} · Usage {primaryTotal.usage.display} ·
                    Add-ons {primaryTotal.add_ons.display} · Credits {primaryTotal.credits.display}
                  </div>
                )}
              </div>

              {data.totals.length > 1 && (
                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {data.totals.map((total) => (
                    <li className="text-sm text-[color:var(--tx2)]" key={total.currency}>
                      <span className="font-medium text-[color:var(--tx)]">
                        {total.total_due.display} due
                      </span>{' '}
                      — Monthly {total.monthly.display} · Usage {total.usage.display} · Add-ons{' '}
                      {total.add_ons.display} · Credits {total.credits.display}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-5 grid gap-6 border-t border-[color:var(--sep)] pt-5 sm:grid-cols-3">
                <div>
                  <div className="text-sm text-[color:var(--tx2)]">Plan</div>
                  <div className="mt-0.5 font-medium text-[color:var(--tx)]">{data.plan.display_name}</div>
                  <div className="mt-0.5 text-sm text-[color:var(--tx2)]">{data.plan.markup_display} markup</div>
                </div>
                <div>
                  <div className="text-sm text-[color:var(--tx2)]">Monthly</div>
                  <div className="mt-0.5 font-medium text-[color:var(--tx)]">{data.plan.monthly_subscription.display}</div>
                  <div className="mt-0.5 text-sm text-[color:var(--tx2)]">{data.plan.assignment.scope} assignment</div>
                </div>
                <div>
                  <div className="text-sm text-[color:var(--tx2)]">Subscription</div>
                  <div className="mt-0.5 font-medium text-[color:var(--tx)]">{data.subscription?.display_status ?? 'Not subscribed'}</div>
                  <div className="mt-0.5 text-sm text-[color:var(--tx2)]">
                    {data.subscription?.cancel_at_period_end
                      ? 'Cancellation is scheduled'
                      : data.subscription
                        ? 'Subscription managed by SSO'
                        : 'No direct subscription'}
                  </div>
                </div>
              </div>

              <UoaBillingStatementDetails statement={data} />

              <div className="mt-8">
                <h2 className="mb-1 text-[17px] font-semibold text-[color:var(--tx)]">Actions</h2>
                <ul className="divide-y divide-[color:var(--sep)]">
                  {data.actions.map((action) => (
                    <li className="flex flex-wrap items-center justify-between gap-3 py-3.5" key={action.id}>
                      <div className="min-w-0">
                        <div className="font-medium text-[color:var(--tx)]">{action.label}</div>
                        <div className="mt-0.5 text-sm text-[color:var(--tx2)]">
                          {action.description}
                          {!action.enabled && action.disabled_reason && (
                            <span className="text-[color:var(--tx3)]"> — {action.disabled_reason}</span>
                          )}
                        </div>
                      </div>
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
      </div>

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
