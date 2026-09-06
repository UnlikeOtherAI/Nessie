import { useCallback, useState } from 'react'
import { ApiClientError } from '@nessie/client-core'

/**
 * Turns a rejected request into the two things a form can render: a message
 * for the whole form, and a message per field.
 *
 * The server has always sent enough to do this — `parseInput` puts Zod's
 * `flatten()` into the error envelope's `details` — and no client read it.
 * Around forty error sites rendered a bare paragraph above or below the form
 * instead, so a person given "Invalid request payload" had to guess which of
 * six fields it meant.
 */

export type FormErrors = {
  /** Keyed by the field name the server used, which matches the request body. */
  fieldErrors: Record<string, string>
  /** The whole-form message: a refusal, a conflict, a network failure. */
  formError: string | undefined
}

export const EMPTY_FORM_ERRORS: FormErrors = { fieldErrors: {}, formError: undefined }

type ZodFlattened = {
  fieldErrors?: Record<string, string[] | undefined>
  formErrors?: string[]
}

const isZodFlattened = (value: unknown): value is ZodFlattened =>
  typeof value === 'object' && value !== null && ('fieldErrors' in value || 'formErrors' in value)

export const toFormErrors = (error: unknown): FormErrors => {
  if (!(error instanceof ApiClientError)) {
    return {
      fieldErrors: {},
      // A thrown non-API error is a network or programming failure, and the
      // person cannot act on its text. Say what happened, not what it said.
      formError: error instanceof Error && error.message
        ? error.message
        : 'Something went wrong. Try again.',
    }
  }

  const fieldErrors: Record<string, string> = {}

  if (isZodFlattened(error.details)) {
    for (const [field, messages] of Object.entries(error.details.fieldErrors ?? {})) {
      const first = messages?.[0]
      if (first) fieldErrors[field] = first
    }
  }

  const hasFieldError = Object.keys(fieldErrors).length > 0

  return {
    fieldErrors,
    // Suppressed once every complaint has landed on a field: repeating
    // "Invalid request payload" above a form whose fields are already marked
    // adds nothing and reads as a second, separate failure.
    formError: hasFieldError ? undefined : error.message,
  }
}

/**
 * A single sentence for a form that renders one message rather than
 * per-field errors. Twelve call sites hand-rolled
 * `error instanceof Error ? error.message : fallback`, which reads
 * `ApiClientError.message` (already the server's text) but never its
 * `details` — so a `VALIDATION_ERROR` with per-field complaints and a generic
 * top-level message ("Invalid request payload") rendered exactly that,
 * instead of the field complaint that actually explains the failure.
 */
export const formErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof ApiClientError) {
    if (isZodFlattened(error.details)) {
      const fieldMessages = Object.values(error.details.fieldErrors ?? {}).flatMap(
        (messages) => messages ?? [],
      )
      if (fieldMessages.length > 0) return fieldMessages.join(' ')

      const formMessages = error.details.formErrors ?? []
      if (formMessages.length > 0) return formMessages.join(' ')
    }
    return error.message || fallback
  }

  return error instanceof Error && error.message ? error.message : fallback
}

export type FormSubmitResult<TInput, TOutput> = FormErrors & {
  isPending: boolean
  /** Clears any error left from a previous attempt — call it when a dialog reopens. */
  reset: () => void
  submit: (input: TInput) => Promise<TOutput | undefined>
}

/**
 * The hook `FormField`'s doc comment has always named: wraps a mutation's
 * `mutateAsync` with `toFormErrors`, so a dialog gets field errors and a
 * form-level message without hand-writing its own `try`/`catch`/`setError`.
 * Returns `undefined` on failure — the caller's own `if (result) ...` decides
 * what success does (close the dialog, clear a field), the same shape a
 * `mutateAsync` rejection already forces callers to handle.
 */
export const useFormSubmit = <TInput, TOutput>(
  mutateAsync: (input: TInput) => Promise<TOutput>,
): FormSubmitResult<TInput, TOutput> => {
  const [errors, setErrors] = useState<FormErrors>(EMPTY_FORM_ERRORS)
  const [isPending, setIsPending] = useState(false)

  const submit = useCallback(
    async (input: TInput) => {
      setErrors(EMPTY_FORM_ERRORS)
      setIsPending(true)
      try {
        return await mutateAsync(input)
      } catch (error) {
        setErrors(toFormErrors(error))
        return undefined
      } finally {
        setIsPending(false)
      }
    },
    [mutateAsync],
  )

  const reset = useCallback(() => setErrors(EMPTY_FORM_ERRORS), [])

  return { ...errors, isPending, reset, submit }
}
