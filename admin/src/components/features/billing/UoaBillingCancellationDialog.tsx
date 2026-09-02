import {
  useEffect,
  useState,
} from 'react'
import type {
  BillingCancellationConfirmationV1,
  BillingCancellationPreviewV1,
  BillingCancellationSelection,
} from '@unlikeotherai/billing-statement-protocol'
import { useOverlay } from '../../overlays/useOverlay'

type UoaBillingCancellationDialogProps = {
  confirmation: BillingCancellationConfirmationV1 | null
  error: string | null
  onClose: () => void
  onConfirm: (selection: BillingCancellationSelection | null) => void
  pending: boolean
  preview: BillingCancellationPreviewV1 | null
}

const CloseButton = ({
  disabled,
  onClose,
}: {
  disabled: boolean
  onClose: () => void
}) => (
  <button
    aria-label="Close"
    className={[
      'flex h-7 w-7 items-center justify-center rounded',
      'text-[color:var(--tx3)] hover:bg-[color:var(--overlay)]',
      'hover:text-[color:var(--tx)] disabled:opacity-40',
    ].join(' ')}
    disabled={disabled}
    onClick={onClose}
    type="button"
  >
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        d="M6 18L18 6M6 6l12 12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </button>
)

export const UoaBillingCancellationDialog = ({
  confirmation,
  error,
  onClose,
  onConfirm,
  pending,
  preview,
}: UoaBillingCancellationDialogProps) => {
  const overlay = useOverlay({
    dismissDisabled: pending,
    id: 'uoa-billing-cancellation',
    kind: 'modal',
    label: 'Close',
    onClose,
    open: true,
  })
  const [selection, setSelection] =
    useState<BillingCancellationSelection | null>(null)

  useEffect(() => {
    setSelection(preview?.confirm_action.default_selection ?? null)
  }, [preview])

  const title = confirmation?.title ?? preview?.title ?? 'Subscription'
  const message = confirmation?.message ?? preview?.message ?? ''

  return (
    // Not the shared `Dialog`: a `max-w-2xl` `admin-card` on `--main` with its
    // own `data-testid` panel hook — a different panel family from the shell's
    // `.create-channel-panel`. `useOverlay` still gives it the Back
    // registration, focus trap, drag-safe scrim and layer every other overlay
    // gets (docs/navigation.md §7).
    <div
      {...overlay.scrimProps}
      className={[
        'fixed inset-0 flex items-center justify-center',
        'bg-[var(--scrim-strong)] px-4 backdrop-blur-sm',
      ].join(' ')}
      style={overlay.layerStyle}
    >
      <div
        aria-labelledby="uoa-billing-cancellation-title"
        aria-modal="true"
        className={[
          'admin-card max-h-[min(760px,90vh)] w-full max-w-2xl',
          'overflow-y-auto rounded-xl border border-[color:var(--sep)]',
          'bg-[color:var(--main)] p-6 text-[color:var(--tx)]',
        ].join(' ')}
        data-testid="uoa-cancellation-dialog"
        ref={overlay.panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              className="text-lg font-semibold"
              id="uoa-billing-cancellation-title"
            >
              {title}
            </h2>
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              {message}
            </p>
          </div>
          <CloseButton disabled={pending} onClose={onClose} />
        </div>

        {preview && !confirmation && (
          <>
            {preview.choices.length > 0 && (
              <fieldset className="mt-5 grid gap-2">
                <legend className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  Choose what to cancel
                </legend>
                {preview.choices.map((choice) => (
                  <label
                    className={[
                      'mt-1 flex cursor-pointer items-start gap-3 rounded-lg',
                      'border border-[color:var(--sep)] p-3',
                      'has-[:checked]:border-[color:var(--accent)]',
                      'has-[:checked]:bg-[color:var(--accent-soft)]',
                    ].join(' ')}
                    key={choice.id}
                  >
                    <input
                      checked={selection === choice.id}
                      className="mt-1"
                      name="uoa-cancellation-choice"
                      onChange={() => setSelection(choice.id)}
                      type="radio"
                      value={choice.id}
                    />
                    <span>
                      <span className="block text-sm font-semibold">
                        {choice.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-[color:var(--tx2)]">
                        {choice.description}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            {preview.direct_services.length > 0 && (
              <div className="mt-5">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  Direct subscriptions checked by SSO
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {preview.direct_services.map((service) => (
                    <div
                      className="rounded-lg border border-[color:var(--sep)] p-3"
                      key={service.service_id}
                    >
                      <div className="text-sm font-semibold">
                        {service.display_name}
                      </div>
                      <div className="mt-1 text-xs text-[color:var(--tx2)]">
                        {service.direct_user_count} direct{' '}
                        {service.direct_user_count === 1 ? 'user' : 'users'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.indirect_services.length > 0 && (
              <div className="mt-5">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  Indirect services
                </div>
                <div className="mt-2 grid gap-2">
                  {preview.indirect_services.map((service) => (
                    <div
                      className="rounded-lg bg-[color:var(--overlay-weak)] p-3"
                      key={service.product}
                    >
                      <div className="text-sm font-semibold">
                        {service.display_name}
                      </div>
                      <div className="mt-1 text-xs text-[color:var(--tx2)]">
                        {service.impact}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="mt-4 text-sm text-[color:var(--danger-text)]">
                {error}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button
                className="admin-button admin-button-secondary"
                disabled={pending}
                onClick={onClose}
                type="button"
              >
                Keep subscription
              </button>
              <button
                className={[
                  'admin-button admin-button-primary',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                ].join(' ')}
                data-testid="uoa-cancellation-confirm"
                disabled={
                  pending
                  || (preview.confirm_action.selection_required && !selection)
                }
                onClick={() => onConfirm(selection)}
                type="button"
              >
                {pending ? 'Confirming…' : preview.confirm_action.label}
              </button>
            </div>
          </>
        )}

        {confirmation && (
          <>
            <div className="mt-5 grid gap-2">
              {confirmation.cancelled_services.map((service) => (
                <div
                  className="rounded-lg border border-[color:var(--sep)] p-3"
                  key={service.service_id}
                >
                  <div className="text-sm font-semibold">
                    {service.display_name}
                  </div>
                  {service.effective_at && (
                    <div className="mt-1 text-xs text-[color:var(--tx2)]">
                      Effective {new Date(service.effective_at).toLocaleDateString()}
                    </div>
                  )}
                </div>
              ))}
              {confirmation.indirect_services.map((service) => (
                <div
                  className="rounded-lg bg-[color:var(--overlay-weak)] p-3"
                  key={service.product}
                >
                  <div className="text-sm font-semibold">
                    {service.display_name}
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--tx2)]">
                    {service.impact}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                className="admin-button admin-button-primary"
                onClick={onClose}
                type="button"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
