import { createContext, useContext, useId, type ReactNode } from 'react'
import { FieldLabel } from '../primitives/FieldLabel'
import { fieldErrorId, renderFieldError } from './FormFieldError'

/**
 * Label, control, help text and error, wired together.
 *
 * The wiring is the point. `FormFieldError` has shipped the `aria-invalid` /
 * `aria-describedby` / `role="alert"` contract for a while and exactly two
 * files composed it; the other forty-odd error lines were bare paragraphs,
 * roughly half of them without `role="alert"` and none of them pointing back
 * at the control that failed. A contract nobody remembers to satisfy is not a
 * contract, so this component satisfies it and the control reads what it needs
 * from context rather than from props a call site has to pass correctly.
 *
 * Errors arrive on submit, never per keystroke — `role="alert"` interrupts a
 * screen reader, and a message that recomputes as someone types would chatter.
 */

type FormFieldContextValue = {
  describedBy: string | undefined
  id: string
  invalid: boolean
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null)

export const useFormFieldControl = (): FormFieldContextValue | null => useContext(FormFieldContext)

type FormFieldProps = {
  children: ReactNode
  className?: string
  /**
   * A message from a rejected submit or a failed mutation. Field-level
   * messages from the API arrive here through `useFormSubmit`, which maps the
   * `VALIDATION_ERROR` envelope's `details.fieldErrors` onto field names.
   */
  error?: string
  /**
   * How to fill the field in, shown under it. It is a real line of text rather
   * than a placeholder: a placeholder disappears exactly when a person starts
   * needing it.
   */
  help?: ReactNode
  /**
   * Pins the control's DOM id instead of generating one.
   *
   * For the rare case where something outside React resolves the control by
   * id — the Agent Designer's assistant reveals a field with
   * `document.getElementById('agent-name')` as it writes into it. Without this
   * those four fields had to drop out of `FormField` entirely and hand-wire a
   * `FieldLabel`, which cost them the error wiring this component exists to
   * guarantee. A generated id is right everywhere else and stays the default.
   */
  id?: string
  label: ReactNode
  required?: boolean
}

export const FormField = ({
  children,
  className,
  error,
  help,
  id: pinnedId,
  label,
  required = false,
}: FormFieldProps) => {
  const generatedId = useId()
  const id = pinnedId ?? generatedId
  const helpId = `${id}-help`
  const describedBy = [help ? helpId : null, error ? fieldErrorId(id) : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={['grid gap-1.5', className ?? ''].filter(Boolean).join(' ')}>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>

      <FormFieldContext.Provider
        value={{ describedBy: describedBy || undefined, id, invalid: Boolean(error) }}
      >
        {children}
      </FormFieldContext.Provider>

      {help ? (
        <div className="text-xs text-[color:var(--tx3)]" id={helpId}>
          {help}
        </div>
      ) : null}

      {renderFieldError(id, error)}
    </div>
  )
}
