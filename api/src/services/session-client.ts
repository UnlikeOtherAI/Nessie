import {
  SessionClientTypeSchema,
  type SessionClientType,
} from '@nessie/schemas'

export const SESSION_CLIENT_HEADER = 'x-nessie-session-client'

/** Accept only the small, display-only native-shell vocabulary we persist. */
export const parseSessionClientType = (
  value: string | string[] | undefined,
): SessionClientType | null => {
  if (typeof value !== 'string') return null
  const parsed = SessionClientTypeSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
