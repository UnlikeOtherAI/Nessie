import { MailboxConnectionForm } from '../mailbox-connections/MailboxConnectionForm'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const hasEmailAccountConnectCard = (
  metadata: Record<string, unknown> | undefined,
): boolean => {
  const card = metadata?.card
  return isRecord(card) && card.kind === 'email_account_connect'
}

export const readEmailAccountConnectScope = (
  metadata: Record<string, unknown> | undefined,
): 'user' | 'team' | null => {
  if (!hasEmailAccountConnectCard(metadata)) return null
  const card = metadata?.card as Record<string, unknown>
  return card.scope === 'team' ? 'team' : 'user'
}

/**
 * Chat doorway only. The modal itself is the same address-first component used
 * by Settings, so discovery, OAuth redirects and secret entry have one owner.
 */
export const EmailAccountConnectCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const scope = readEmailAccountConnectScope(metadata)
  if (!scope) return null
  const shared = scope === 'team'

  return (
    <div className="mt-2 max-w-2xl rounded-lg border border-[var(--sep)] bg-[var(--panel)] p-3">
      <span className="text-[11px] font-semibold uppercase text-[var(--tx3)]">
        Email account
      </span>
      <div className="mt-1 text-sm font-semibold text-[var(--tx)]">
        {shared ? 'Connect shared email securely' : 'Connect email securely'}
      </div>
      <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
        Start with the address. Nessie will find the provider and use the safest
        available connection method.
      </p>
      <div className="mt-3">
        <MailboxConnectionForm scope={scope} />
      </div>
    </div>
  )
}
