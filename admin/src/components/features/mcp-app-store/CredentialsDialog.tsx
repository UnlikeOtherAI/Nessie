import { useState, type FormEvent } from 'react'
import type { McpCredentialPrincipalType } from '@nessie/schemas'
import {
  useInstanceCredentials,
  useUpsertInstanceCredential,
  useDeleteInstanceCredential,
  type McpServerInstanceRecord,
} from '../../../facades/mcp-instances/hooks'

/**
 * Per-server credential modal. The user enters a `credentialRef` (which the
 * runtime secret resolver dereferences — never plaintext per plan D7) keyed by
 * principal type + principal ID. For oauth2 servers we also surface a
 * "Connect" button that hands off to the API's OAuth2 start route (the route
 * will be exposed in a later slice; the button is rendered for parity with the
 * UI plan §7).
 */

type CredentialsDialogProps = {
  instance: McpServerInstanceRecord
  oauth2: boolean
  onClose: () => void
}

const PRINCIPAL_TYPES: McpCredentialPrincipalType[] = [
  'user',
  'agent',
  'channel',
  'team',
  'project',
  'organization',
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

const ghostBtn = [
  'admin-button rounded-md border border-[color:var(--sep)]',
  'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
].join(' ')

type OverrideRowProps = {
  credentialRef: string
  disabled: boolean
  onRemove: () => void
  principalId: string
  principalType: McpCredentialPrincipalType
}

/**
 * Renders a single saved credential override. The `credentialRef` is treated
 * as sensitive (revealing it leaks naming patterns and which keys exist) and
 * is masked by default with a per-row reveal toggle.
 */
const OverrideRow = ({
  credentialRef,
  disabled,
  onRemove,
  principalId,
  principalType,
}: OverrideRowProps) => {
  const [revealed, setRevealed] = useState(false)
  return (
    <div
      className={[
        'flex items-center justify-between gap-3 rounded-md',
        'border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-2',
      ].join(' ')}
    >
      <div className="min-w-0 text-sm">
        <div className="truncate text-[var(--tx)]">
          {principalType}:{principalId.slice(0, 8)}…
        </div>
        <div className="flex items-center gap-2 text-xs text-[color:var(--tx3)]">
          <span className="truncate font-mono">
            {revealed ? credentialRef : '••••••••'}
          </span>
          <button
            aria-label={
              revealed ? 'Hide credential reference' : 'Show credential reference'
            }
            aria-pressed={revealed}
            className={ghostBtn}
            onClick={() => setRevealed((prev) => !prev)}
            title={
              revealed ? 'Hide credential reference' : 'Show credential reference'
            }
            type="button"
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      <button
        className={ghostBtn}
        disabled={disabled}
        onClick={onRemove}
        type="button"
      >
        Remove
      </button>
    </div>
  )
}

export const CredentialsDialog = ({
  instance,
  oauth2,
  onClose,
}: CredentialsDialogProps) => {
  const { data: overrides = [] } = useInstanceCredentials(instance.id)
  const upsert = useUpsertInstanceCredential()
  const remove = useDeleteInstanceCredential()

  const [principalType, setPrincipalType] =
    useState<McpCredentialPrincipalType>('user')
  const [principalId, setPrincipalId] = useState('')
  const [credentialRef, setCredentialRef] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (!principalId.trim() || !credentialRef.trim()) {
      setError('Principal ID and credential ref are required')
      return
    }
    const payload = {
      instanceId: instance.id,
      principalType,
      principalId: principalId.trim(),
      credentialRef: credentialRef.trim(),
    }
    // Clear sensitive state BEFORE the request so closing the dialog mid-flight
    // leaves no secret in React state or the DOM.
    setPrincipalId('')
    setCredentialRef('')
    try {
      await upsert.mutateAsync(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save')
    }
  }

  const oauthStartUrl = `/api/mcp/instances/${instance.id}/oauth/start`

  return (
    <div
      className={[
        'fixed inset-0 z-50 flex items-center justify-center',
        'bg-[var(--scrim-strong)] px-4',
      ].join(' ')}
    >
      <div
        className={[
          'admin-card w-full max-w-xl rounded-xl border border-[color:var(--sep)]',
          'bg-[color:var(--main)] p-6 text-[color:var(--tx)]',
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--tx)]">
              Credentials for {instance.scopeType}:{instance.scopeId.slice(0, 8)}…
            </h2>
            <p className="mt-1 text-sm text-[color:var(--tx3)]">
              Per-principal credential overrides. Resolved 7-deep (user → agent
              → channel → team → project → org → default) at call time.
            </p>
          </div>
          <button className={ghostBtn} onClick={onClose} type="button">
            Close
          </button>
        </div>

        {oauth2 && (
          <a
            className={[
              'admin-button admin-button-primary mt-4 inline-flex',
              'rounded-md px-3 py-1 text-xs font-semibold',
            ].join(' ')}
            href={oauthStartUrl}
            rel="noreferrer"
            target="_blank"
          >
            Connect via OAuth2
          </a>
        )}

        <form
          className="mt-4 grid gap-3 border-t border-[color:var(--sep)] pt-4"
          onSubmit={(event) => void submit(event)}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={labelClass}>
              Principal type
              <select
                className={inputClass}
                onChange={(event) =>
                  setPrincipalType(
                    event.target.value as McpCredentialPrincipalType,
                  )
                }
                value={principalType}
              >
                {PRINCIPAL_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Principal ID
              <input
                className={inputClass}
                onChange={(event) => setPrincipalId(event.target.value)}
                placeholder="UUID"
                value={principalId}
              />
            </label>
            <label className={labelClass}>
              Credential ref
              <input
                autoComplete="new-password"
                className={inputClass}
                name="credentialRef"
                onChange={(event) => setCredentialRef(event.target.value)}
                placeholder="secret://orgs/.../tokens/me"
                type="password"
                value={credentialRef}
              />
            </label>
          </div>
          {error ? (
            <div className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger-text)]">
              {error}
            </div>
          ) : null}
          <div className="flex justify-end">
            <button
              className={[
                'admin-button admin-button-primary rounded-md',
                'px-4 py-2 text-sm font-semibold',
                'disabled:cursor-not-allowed disabled:opacity-40',
              ].join(' ')}
              disabled={upsert.isPending}
              type="submit"
            >
              {upsert.isPending ? 'Saving…' : 'Save override'}
            </button>
          </div>
        </form>

        <div className="mt-6">
          <div className={labelClass}>Existing overrides</div>
          <div className="mt-2 grid gap-2">
            {overrides.length === 0 ? (
              <div className="text-sm text-[color:var(--tx3)]">
                No overrides yet.
              </div>
            ) : (
              overrides.map((override) => (
                <OverrideRow
                  // Include `updatedAt` so an edit to an existing override
                  // remounts the row and forces it back to the masked state —
                  // keying on `id` alone preserved `revealed=true` across the
                  // post-upsert refetch (regression vs. #31 masking intent).
                  key={`${override.id}-${override.updatedAt}`}
                  credentialRef={override.credentialRef}
                  disabled={remove.isPending}
                  onRemove={() =>
                    remove.mutate({
                      instanceId: instance.id,
                      principalType: override.principalType,
                      principalId: override.principalId,
                    })
                  }
                  principalId={override.principalId}
                  principalType={override.principalType}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
