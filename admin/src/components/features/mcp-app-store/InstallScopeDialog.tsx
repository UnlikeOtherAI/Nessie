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
    scopeType: McpServerScopeType
    scopeId: string
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
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (!scopeId.trim()) {
      setError('Scope ID is required')
      return
    }
    try {
      await onConfirm({ scopeType, scopeId: scopeId.trim() })
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
