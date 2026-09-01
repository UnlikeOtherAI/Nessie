import type { AuthorizedActionContext } from '@nessie/schemas'

/**
 * Tenancy floor for every catalog read.
 *
 * A catalog entry belongs either to one organisation or to the instance itself
 * (`organizationId: null` — the first-party, integration-owned rows). No read
 * path may return another tenant's rows, including for an org owner: an org
 * owner is not a superuser, and private connector rows carry plaintext OAuth
 * client secrets and API-key headers.
 */
export const catalogTenancyWhere = (
  actorContext: AuthorizedActionContext,
): { OR: Array<{ organizationId: string | null }> } => ({
  OR: [
    { organizationId: null },
    { organizationId: actorContext.tenant.organizationId },
  ],
})

export const REDACTED = '[redacted]'

/**
 * Key names whose string values are secrets. `*Url` / `*Uri` / `*Id` suffixes
 * are excluded so `tokenUrl`, `authorizationUrl` and `clientId` survive — they
 * are the fields a reader legitimately needs to understand the connector.
 */
const isSecretKey = (key: string): boolean => {
  const normalized = key.toLowerCase()
  if (
    normalized.endsWith('url')
    || normalized.endsWith('uri')
    || normalized.endsWith('id')
  ) {
    return false
  }
  return /secret|password|token|apikey|api[-_]?key|^authorization$|credential|private[-_]?key/
    .test(normalized)
}

/**
 * Replace secret-valued strings anywhere in a config object. Applied to catalog
 * rows on the way out of the API: a published store entry is readable by every
 * member of the instance, so an API key sitting in `defaultTransportConfig`
 * headers would otherwise be handed to all of them.
 */
export const redactConfigSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactConfigSecrets)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) =>
        isSecretKey(key) && typeof entryValue === 'string'
          ? [key, REDACTED]
          : [key, redactConfigSecrets(entryValue)],
      ),
    )
  }
  return value
}
