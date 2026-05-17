import type { ReactElement } from 'react'
import type { StepErrors } from './add-server-wizard-validation'

/**
 * A11y helpers for {@link ./AddServerWizard.tsx}. Each field with a step error
 * gets `aria-invalid` + `aria-describedby` on the input, paired with a
 * deterministically-id'd error region carrying `role="alert"` so screen readers
 * announce changes. Kept as a sibling module so the wizard stays under the
 * 500-line architectural cap.
 */

const inlineErrorClass = [
  'mt-1 rounded-md border border-rose-400/40 bg-rose-500/10',
  'px-2 py-1 text-xs text-rose-200',
].join(' ')

export const ariaFor = (
  key: keyof StepErrors,
  errors: StepErrors,
): { 'aria-invalid': boolean; 'aria-describedby': string | undefined } => ({
  'aria-invalid': Boolean(errors[key]),
  'aria-describedby': errors[key] ? `${key}-error` : undefined,
})

export const renderFieldError = (
  key: keyof StepErrors,
  message: string | undefined,
  testId?: string,
): ReactElement | null => (message ? (
  <div className={inlineErrorClass} data-testid={testId} id={`${key}-error`} role="alert">
    {message}
  </div>
) : null)
