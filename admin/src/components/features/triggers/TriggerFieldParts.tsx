import type { ReactNode } from 'react'

import { fieldLabelClass } from './trigger-config'

/**
 * The two pieces every typed trigger's fields are built from
 * (`TicketTriggerFields`, `DocumentTriggerFields`): a titled group with the
 * sentence that explains it, and the server's refusal of a field, under it.
 * `data-field-error` names the field, which is how a browser suite finds where
 * a refusal landed.
 */

export const TriggerFieldError = ({ field, message }: { field: string; message?: string }) =>
  message ? (
    <p className="text-xs text-[color:var(--danger-text)]" data-field-error={field} role="alert">
      {message}
    </p>
  ) : null

export const TriggerFieldSection = ({
  children,
  hint,
  title,
}: {
  children: ReactNode
  hint?: string
  title: string
}) => (
  <fieldset className="grid gap-2 md:col-span-2">
    <legend className={fieldLabelClass}>{title}</legend>
    {hint ? <p className="text-xs text-[color:var(--tx3)]">{hint}</p> : null}
    {children}
  </fieldset>
)
