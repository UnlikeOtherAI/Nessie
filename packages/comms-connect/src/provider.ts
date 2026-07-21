/**
 * The set of communications providers a user can connect. Kept as a plain
 * string union (not a Prisma enum import) so the provider-agnostic core has no
 * database dependency; the values are identical to the `CommsProvider` Prisma
 * enum members and are used verbatim in the canonical message id.
 */
export const COMMS_PROVIDER_IDS = ['slack', 'google', 'microsoft'] as const

export type CommsProviderId = (typeof COMMS_PROVIDER_IDS)[number]

export const isCommsProviderId = (value: unknown): value is CommsProviderId =>
  typeof value === 'string'
  && (COMMS_PROVIDER_IDS as readonly string[]).includes(value)
