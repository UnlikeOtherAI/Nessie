import { useState, type FormEvent } from 'react'
import type { McpCredentialPrincipalType } from '@nessie/schemas'
import {
  useInstanceCredentials,
  useUpsertInstanceCredential,
  useDeleteInstanceCredential,
  type McpServerInstanceRecord,
} from '../../../facades/mcp-instances/hooks'
import {
  useSetInstanceSecret,
  useStartInstanceOAuth,
} from '../../../facades/mcp-library/hooks'
import { Notice } from '../../primitives/Notice'
import { SectionLabel } from '../../primitives/SectionLabel'

/**
 * Per-server credential modal. Raw API keys and tokens cross the encrypted
 * secret-store boundary once and are attached to a principal by an opaque,
 * server-minted reference that is never exposed to the browser. For oauth2
 * servers we also surface a
 * "Connect" button that starts the OAuth flow (static or dynamic) and opens
 * the provider's sign-in page in a new tab. A separate password field stores a
 * raw token through the encrypted `/secret` boundary as the current user's
 * override; plaintext is cleared before the request and never read back.
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

// The same treatment as <SectionLabel size="2xs">, kept as a class string for
// the <label> elements: SectionLabel renders div/h2/h3/p/span, and swapping a
// <label> for one of those would drop the implicit label-to-control binding.
const labelClass = [
  'text-[11px] font-semibold uppercase tracking-[0.18em]',
  'text-[color:var(--tx3)]',
].join(' ')

const inputClass = [
  'admin-input mt-1',
  'bg-[var(--scrim)] px-3 py-2 text-sm text-[var(--tx)]',
  'focus:border-[color:var(--accent)] focus:outline-none',
].join(' ')

const ghostBtn = [
  'admin-button border border-[color:var(--sep)]',
  'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
].join(' ')

type OverrideRowProps = {
  disabled: boolean
  onRemove: () => void
  principalId: string
  principalType: McpCredentialPrincipalType
}

/**
 * Renders a single saved credential override without exposing its internal
 * encrypted-store reference.
 */
const OverrideRow = ({
  disabled,
  onRemove,
  principalId,
  principalType,
}: OverrideRowProps) => (
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
        <div className="text-xs text-[color:var(--tx3)]">Stored encrypted</div>
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

export const CredentialsDialog = ({
  instance,
  oauth2,
  onClose,
}: CredentialsDialogProps) => {
  const { data: overrides = [] } = useInstanceCredentials(instance.id)
  const upsert = useUpsertInstanceCredential()
  const remove = useDeleteInstanceCredential()
  const setSecret = useSetInstanceSecret()

  const [principalType, setPrincipalType] =
    useState<McpCredentialPrincipalType>('user')
  const [principalId, setPrincipalId] = useState('')
  const [overrideSecret, setOverrideSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecretValue] = useState('')
  const [secretError, setSecretError] = useState<string | null>(null)
  const [secretSaved, setSecretSaved] = useState(false)

  const storePersonalSecret = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSecretError(null)
    setSecretSaved(false)
    const plaintext = secret.trim()
    if (!plaintext) {
      setSecretError('Paste a token or API key to store.')
      return
    }
    // Remove plaintext from React state and the DOM before any network wait.
    // The mutation response contains placement only; the secret is never read
    // back into the browser.
    setSecretValue('')
    try {
      await setSecret.mutateAsync({
        instanceId: instance.id,
        secret: plaintext,
        shared: false,
      })
      setSecretSaved(true)
    } catch (caught) {
      setSecretError(
        caught instanceof Error ? caught.message : 'Failed to store credential',
      )
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (!principalId.trim() || !overrideSecret.trim()) {
      setError('Principal ID and credential are required')
      return
    }
    const payload = {
      instanceId: instance.id,
      principalType,
      principalId: principalId.trim(),
      secret: overrideSecret.trim(),
    }
    // Clear sensitive state BEFORE the request so closing the dialog mid-flight
    // leaves no secret in React state or the DOM.
    setPrincipalId('')
    setOverrideSecret('')
    try {
      await upsert.mutateAsync(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save')
    }
  }

  const startOAuth = useStartInstanceOAuth()
  const connectViaOAuth = async () => {
    const flow = await startOAuth.mutateAsync({ instanceId: instance.id })
    window.open(flow.authorizationUrl, '_blank', 'noopener')
  }

  return (
    <div
      className={[
        'fixed inset-0 z-50 flex items-center justify-center',
        'bg-[var(--scrim-strong)] px-4',
      ].join(' ')}
    >
      <div
        className={[
          'admin-card max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto',
          'rounded-xl border border-[color:var(--sep)]',
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
          <button
            className={[
              'admin-button admin-button-primary mt-4',
              'rounded-md px-3 py-1 text-xs font-semibold',
              'disabled:cursor-not-allowed disabled:opacity-40',
            ].join(' ')}
            disabled={startOAuth.isPending}
            onClick={() => void connectViaOAuth()}
            type="button"
          >
            {startOAuth.isPending ? 'Starting…' : 'Connect via OAuth2'}
          </button>
        )}

        <form
          className="mt-4 grid gap-3 border-t border-[color:var(--sep)] pt-4"
          onSubmit={(event) => void storePersonalSecret(event)}
        >
          <div>
            <SectionLabel size="2xs">Store personal credential</SectionLabel>
            <p className="mt-1 text-sm text-[color:var(--tx3)]">
              Stored encrypted as your override for this connector. The value is
              sent once, never displayed, and is not shared with other users.
            </p>
          </div>
          <label className={labelClass}>
            Token or API key
            <input
              autoComplete="new-password"
              className={inputClass}
              name="instanceSecret"
              onChange={(event) => {
                setSecretValue(event.target.value)
                setSecretSaved(false)
              }}
              placeholder="Paste credential"
              type="password"
              value={secret}
            />
          </label>
          {secretError ? (
            <Notice tone="danger">{secretError}</Notice>
          ) : null}
          {secretSaved ? (
            <Notice tone="success">Personal credential stored securely.</Notice>
          ) : null}
          <div className="flex justify-end">
            <button
              className={[
                'admin-button admin-button-primary',
                'px-4 py-2 text-sm font-semibold',
                'disabled:cursor-not-allowed disabled:opacity-40',
              ].join(' ')}
              disabled={setSecret.isPending}
              type="submit"
            >
              {setSecret.isPending ? 'Storing…' : 'Store securely'}
            </button>
          </div>
        </form>

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
              API key or token
              <input
                autoComplete="new-password"
                className={inputClass}
                name="overrideSecret"
                onChange={(event) => setOverrideSecret(event.target.value)}
                placeholder="Paste credential"
                type="password"
                value={overrideSecret}
              />
            </label>
          </div>
          {error ? (
            <Notice tone="danger">{error}</Notice>
          ) : null}
          <div className="flex justify-end">
            <button
              className={[
                'admin-button admin-button-primary',
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
          <SectionLabel size="2xs">Existing overrides</SectionLabel>
          <div className="mt-2 grid gap-2">
            {overrides.length === 0 ? (
              <div className="text-sm text-[color:var(--tx3)]">
                No overrides yet.
              </div>
            ) : (
              overrides.map((override) => (
                <OverrideRow
                  key={`${override.id}-${override.updatedAt}`}
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
