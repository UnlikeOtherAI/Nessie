import type { ReactElement } from 'react'

/**
 * One announceable-error contract for admin forms, promoted out of the MCP
 * add-server wizard (its former home, `features/mcp-app-store/
 * add-server-wizard-field.tsx`, was the only place in the admin that wired a
 * form error to a screen reader at all).
 *
 * The contract is three things that have to agree or the announcement is
 * silently wrong: a deterministic id, `aria-invalid` + `aria-describedby` on
 * the control, and `role="alert"` on the region carrying the message.
 *
 * `role="alert"` interrupts the reader, so it belongs only on a message that
 * appears in response to an action — a rejected submit, a failed mutation —
 * never on one recomputed as the user types. Every call site here sets its
 * error in a submit/step-advance handler and clears it on the next edit; a
 * per-keystroke error would chatter and must not use these helpers.
 *
 * The *visual* is deliberately not part of the contract. `renderFieldError`
 * ships the wizard's boxed treatment for the sites that already had it;
 * `fieldErrorProps` gives the same id/role to a site that keeps its own
 * markup, because the channel dialogs render a bare line of red text and
 * boxing them would be a redesign smuggled in under an a11y fix.
 */

export const fieldErrorId = (key: string): string => `${key}-error`

/** Attributes for the control itself, from a single message. */
export const fieldErrorAria = (
  key: string,
  message: string | null | undefined,
): { 'aria-invalid': boolean; 'aria-describedby': string | undefined } => ({
  'aria-invalid': Boolean(message),
  'aria-describedby': message ? fieldErrorId(key) : undefined,
})

/** The same, keyed into a per-step/per-form error record (the wizard's shape). */
export const ariaFor = <K extends string>(
  key: K,
  errors: Partial<Record<K, string | undefined>>,
): { 'aria-invalid': boolean; 'aria-describedby': string | undefined } =>
  fieldErrorAria(key, errors[key])

/** Attributes for the message region, for a call site keeping its own markup. */
export const fieldErrorProps = (
  key: string,
  testId?: string,
): { 'data-testid': string | undefined; id: string; role: 'alert' } => ({
  'data-testid': testId,
  id: fieldErrorId(key),
  role: 'alert',
})

const inlineErrorClass = [
  'mt-1 rounded-md border border-[var(--danger-border)] bg-[var(--danger-soft)]',
  'px-2 py-1 text-xs text-[var(--danger-text)]',
].join(' ')

export const renderFieldError = (
  key: string,
  message: string | undefined,
  testId?: string,
): ReactElement | null => (message ? (
  <div className={inlineErrorClass} {...fieldErrorProps(key, testId)}>
    {message}
  </div>
) : null)
