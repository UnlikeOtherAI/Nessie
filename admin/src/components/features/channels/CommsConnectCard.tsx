import { useState } from 'react'
import type { CommsProvider } from '../../../lib/api-client'
import {
  useCommsConnections,
  useStartCommsConnection,
} from '../../../facades/connections/hooks'
import { IdentityTile } from '../../primitives/IdentityTile'

/**
 * Interactive chat card rendered from message metadata
 * `{ card: { kind: 'comms_connect', providers: [...] } }`, posted by the
 * Personal Assistant's `comms_connect_card` tool. Each provider row shows a
 * connected state (green check + identity) when the caller already has an
 * active connection, or a Connect button that starts the OAuth flow and opens
 * the provider authorize URL in a new tab. Microsoft is shown disabled until
 * its adapter ships.
 */

const PROVIDER_META: Record<
  CommsProvider,
  { label: string; connectLabel: string; glyph: string; enabled: boolean }
> = {
  slack: { label: 'Slack', connectLabel: 'Connect Slack', glyph: 'S', enabled: true },
  google: { label: 'Gmail', connectLabel: 'Connect Gmail', glyph: 'G', enabled: true },
  microsoft: {
    label: 'Microsoft',
    connectLabel: 'Coming soon',
    glyph: 'M',
    enabled: false,
  },
}

const KNOWN_PROVIDERS = new Set<string>(Object.keys(PROVIDER_META))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const readProviders = (
  metadata: Record<string, unknown> | undefined,
): CommsProvider[] | null => {
  const card = metadata?.card
  if (!isRecord(card) || card.kind !== 'comms_connect') {
    return null
  }
  const raw = card.providers
  const list = Array.isArray(raw)
    ? raw.filter((entry): entry is CommsProvider =>
        typeof entry === 'string' && KNOWN_PROVIDERS.has(entry),
      )
    : []
  const deduped = [...new Set(list)]
  return deduped.length > 0 ? deduped : (['slack', 'google'] as CommsProvider[])
}

const CheckIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ProviderRow = ({ provider }: { provider: CommsProvider }) => {
  const meta = PROVIDER_META[provider]
  const { data } = useCommsConnections()
  const start = useStartCommsConnection()
  const [error, setError] = useState<string | null>(null)

  const connection = data?.connections.find(
    (entry) => entry.provider === provider && entry.status === 'active',
  )

  const onConnect = async () => {
    setError(null)
    try {
      const result = await start.mutateAsync(provider)
      window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer')
    } catch {
      setError('Could not start the connection. Please try again.')
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--sep)] px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <IdentityTile
          background="var(--overlay)"
          color="var(--tx2)"
          fallback={{ kind: 'glyph', glyph: meta.glyph }}
          imageUrl={null}
          label={meta.label}
          size={28}
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--tx)]">{meta.label}</div>
          {connection ? (
            <div className="truncate text-xs text-[var(--tx3)]">{connection.externalUserId}</div>
          ) : error ? (
            <div className="truncate text-xs text-[var(--danger-text)]">{error}</div>
          ) : null}
        </div>
      </div>
      {connection ? (
        <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold text-[var(--success-text)]">
          <CheckIcon />
          Connected
        </span>
      ) : (
        <button
          className={[
            'inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-semibold',
            meta.enabled
              ? 'bg-[var(--accent)] text-[var(--on-accent)]'
              : 'cursor-not-allowed border border-[var(--sep)] bg-[var(--overlay-weak)] text-[var(--tx3)]',
          ].join(' ')}
          disabled={!meta.enabled || start.isPending}
          onClick={onConnect}
          type="button"
        >
          {start.isPending ? 'Opening…' : meta.connectLabel}
        </button>
      )}
    </div>
  )
}

export const CommsConnectCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const providers = readProviders(metadata)
  if (!providers) {
    return null
  }

  return (
    <div className="mt-2 max-w-2xl rounded-lg border border-[var(--sep)] bg-[var(--panel)] p-3">
      <span className="text-[11px] font-semibold uppercase text-[var(--tx3)]">
        Connected accounts
      </span>
      <div className="mt-1 text-sm font-semibold text-[var(--tx)]">
        Connect your communication accounts
      </div>
      <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
        Link an account so I can help across your messages. You choose exactly
        what to import and can disconnect any time.
      </p>
      <div className="mt-3 grid gap-2">
        {providers.map((provider) => (
          <ProviderRow key={provider} provider={provider} />
        ))}
      </div>
    </div>
  )
}
