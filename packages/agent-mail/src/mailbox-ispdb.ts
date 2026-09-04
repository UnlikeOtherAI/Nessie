import type { TrustedMailboxImapSmtpConfig } from '@nessie/schemas'

/**
 * A reviewed snapshot of long-tail provider settings, in the shape Mozilla's
 * public autoconfiguration database publishes them.
 *
 * It is a **snapshot**, deliberately: a third-party configuration endpoint
 * queried at connect time would decide where somebody's mail password is sent,
 * which is the one decision this system never delegates. Every entry here was
 * read from the provider's own published settings page, and carries that
 * reference so the next person can re-verify it rather than trust this file.
 *
 * An entry is a *configuration* source, not a provider adapter: these providers
 * get no OAuth route, no native API and no `MailboxProviderFamily` of their own.
 * They resolve to the generic password path with their real name shown, which
 * is why adding one is a data change and never a schema change.
 */

export const MAILBOX_ISPDB_VERSION = 1

export type MailboxIspdbEntry = {
  /** Mail domains this entry configures, lowercase and already IDNA-canonical. */
  readonly domains: readonly string[]
  /** Shown to the person as "Sign in to …"; the provider's own product name. */
  readonly displayName: string
  readonly config: TrustedMailboxImapSmtpConfig
  /** The provider's published settings page this entry was verified against. */
  readonly reference: string
  /** ISO date that reference was last read. Re-verify before trusting an old one. */
  readonly verifiedOn: string
}

export const MAILBOX_ISPDB: readonly MailboxIspdbEntry[] = []

export const ispdbForDomain = (
  domain: string,
  ispdb: readonly MailboxIspdbEntry[] = MAILBOX_ISPDB,
): MailboxIspdbEntry | undefined =>
  ispdb.find((entry) => entry.domains.includes(domain))
