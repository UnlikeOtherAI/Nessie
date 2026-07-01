import { useState, type FormEvent } from 'react'
import type { McpServerScopeType } from '@nessie/schemas'
import type { McpCatalogEntryRecord } from '../../../facades/mcp-catalog/hooks'

/**
 * Scope picker shown after the admin clicks "Install" on a catalog entry.
 * Installs always pair a `(catalogEntryId, scopeType, scopeId)` tuple — per
 * plan D5/D6 — so the API rejects duplicates at the DB layer. The dialog is
 * intentionally schema-driven: organizationId is implicit and read from the
 * authenticated session by the API, so the user only provides the scope kind
 * and the scope target's UUID.
 */

type InstallScopeDialogProps = {
  catalogEntry: McpCatalogEntryRecord
  onCancel: () => void
  onConfirm: (input: {
    credentialRef?: string | null
    scopeType: McpServerScopeType
    scopeId: string
    transportConfig?: Record<string, unknown>
  }) => Promise<void>
  organizationId: string
  currentUserId: string
  /** Superusers install at any scope; everyone else only at their own user scope. */
  canChooseScope: boolean
  pending?: boolean
}

const ALL_SCOPE_TYPES: McpServerScopeType[] = [
  'organization',
  'project',
  'team',
  'channel',
  'user',
]

const labelClass = [
  'text-[11px] font-semibold uppercase tracking-[0.18em]',
  'text-[color:var(--tx3)]',
].join(' ')

const inputClass = [
  'admin-input mt-1 w-full rounded-md border border-[color:var(--sep)]',
  'bg-[var(--scrim)] px-3 py-2 text-sm text-[var(--tx)]',
  'focus:border-[color:var(--accent)] focus:outline-none',
].join(' ')

const transportUrlFrom = (config: Record<string, unknown>): string =>
  typeof config.url === 'string' ? config.url : ''

const protocolNeedsEndpoint = (protocol: string): boolean =>
  protocol === 'http' || protocol === 'sse' || protocol === 'ws'

export const InstallScopeDialog = ({
  catalogEntry,
  onCancel,
  onConfirm,
  organizationId,
  currentUserId,
  canChooseScope,
  pending = false,
}: InstallScopeDialogProps) => {
  const scopeTypes = canChooseScope ? ALL_SCOPE_TYPES : (['user'] as McpServerScopeType[])
  const [scopeType, setScopeType] = useState<McpServerScopeType>(
    canChooseScope ? 'organization' : 'user',
  )
  const [scopeId, setScopeId] = useState(
    canChooseScope ? organizationId : currentUserId,
  )
  const initialEndpoint = transportUrlFrom(catalogEntry.defaultTransportConfig)
  const needsEndpoint = protocolNeedsEndpoint(catalogEntry.protocol)
  const [endpointUrl, setEndpointUrl] = useState(initialEndpoint)
  const [credentialRef, setCredentialRef] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (!scopeId.trim()) {
      setError('Scope ID is required')
      return
    }
    const trimmedEndpoint = endpointUrl.trim()
    if (needsEndpoint && !trimmedEndpoint) {
      setError('Endpoint URL is required')
      return
    }
    if (needsEndpoint) {
      try {
        const parsed = new URL(trimmedEndpoint)
        if (
          catalogEntry.protocol === 'ws'
          && parsed.protocol !== 'ws:'
          && parsed.protocol !== 'wss:'
        ) {
          setError('Endpoint URL must use ws:// or wss://')
          return
        }
        if (
          (catalogEntry.protocol === 'http' || catalogEntry.protocol === 'sse')
          && parsed.protocol !== 'http:'
          && parsed.protocol !== 'https:'
        ) {
          setError('Endpoint URL must use http:// or https://')
          return
        }
      } catch {
        setError('Endpoint URL is invalid')
        return
      }
    }
    try {
      await onConfirm({
        credentialRef: credentialRef.trim() || null,
        scopeType,
        scopeId: scopeId.trim(),
        transportConfig: needsEndpoint
          ? { transport: catalogEntry.protocol, url: trimmedEndpoint }
          : undefined,
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Install failed')
    }
  }

  return (
    <div
      className={[
        'fixed inset-0 z-50 flex items-center justify-center',
        'bg-[var(--scrim-strong)] px-4',
      ].join(' ')}
    >
      <form
        className={[
          'admin-card w-full max-w-md rounded-xl border border-[color:var(--sep)]',
          'bg-[color:var(--main)] p-6 text-[color:var(--tx)]',
        ].join(' ')}
        onSubmit={(event) => void submit(event)}
      >
        <h2 className="text-lg font-semibold text-[var(--tx)]">
          Install {catalogEntry.label}
        </h2>
        <p className="mt-1 text-sm text-[color:var(--tx3)]">
          Choose the scope this server will be installed at.
        </p>

        <div className="mt-4 grid gap-3">
          <label className={labelClass}>
            Scope type
            <select
              className={inputClass}
              onChange={(event) => {
                const next = event.target.value as McpServerScopeType
                setScopeType(next)
                if (next === 'organization') {
                  setScopeId(organizationId)
                } else if (next === 'user') {
                  setScopeId(currentUserId)
                }
              }}
              value={scopeType}
            >
              {scopeTypes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Scope target ID (UUID)
            <input
              className={inputClass}
              onChange={(event) => setScopeId(event.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              value={scopeId}
            />
          </label>
          {needsEndpoint ? (
            <label className={labelClass}>
              Endpoint URL
              <input
                className={inputClass}
                onChange={(event) => setEndpointUrl(event.target.value)}
                placeholder={
                  catalogEntry.protocol === 'sse'
                    ? 'https://crawler.example.com/mcp/sse'
                    : 'https://example.com/mcp'
                }
                value={endpointUrl}
              />
            </label>
          ) : null}
          {catalogEntry.authMethod !== 'none' ? (
            <label className={labelClass}>
              Credential ref
              <input
                autoComplete="new-password"
                className={inputClass}
                onChange={(event) => setCredentialRef(event.target.value)}
                placeholder="CRAWL4AI_BEARER_TOKEN"
                type="password"
                value={credentialRef}
              />
            </label>
          ) : null}
          {error ? (
            <div className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger-text)]">
              {error}
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            className={[
              'admin-button rounded-md border border-[color:var(--sep)]',
              'px-4 py-2 text-sm text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
            ].join(' ')}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className={[
              'admin-button admin-button-primary rounded-md px-4 py-2',
              'text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40',
            ].join(' ')}
            disabled={pending}
            type="submit"
          >
            {pending ? 'Installing…' : 'Install'}
          </button>
        </div>
      </form>
    </div>
  )
}
