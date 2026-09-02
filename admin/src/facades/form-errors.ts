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
