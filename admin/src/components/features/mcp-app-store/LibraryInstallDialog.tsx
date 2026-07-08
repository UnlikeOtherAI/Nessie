import { useState, type FormEvent } from 'react'
import {
  useImportLibraryEntry,
  useSetInstanceSecret,
  useStartInstanceOAuth,
  type McpLibraryEntryRecord,
} from '../../../facades/mcp-library/hooks'
import {
  useCreateInstance,
  useTestInstance,
} from '../../../facades/mcp-instances/hooks'

/**
 * One-click install flow for a library entry (or a discovered endpoint):
 * import → install at the chosen scope → credential step → connection test +
 * tool discovery. Designed for non-technical users: no UUIDs, no env-var
 * refs. The credential step adapts to the server: paste-a-key connectors
 * store the secret encrypted; OAuth connectors open the provider's sign-in
 * page in a new tab and finish with a connection test once the user approves.
 */

type LibraryInstallDialogProps = {
  entry: McpLibraryEntryRecord
  currentUserId: string
  organizationId: string
  /** Owners/admins may share to the whole organisation. */
  canShareToOrg: boolean
  /** Only owners can also publish the entry into the org store. */
  isOwner: boolean
  onDone: (catalogEntryId: string) => void
  onCancel: () => void
}

const labelClass = [
  'text-[11px] font-semibold uppercase tracking-[0.18em]',
  'text-[color:var(--tx3)]',
].join(' ')

const inputClass = [
  'admin-input mt-1 w-full rounded-md border border-[color:var(--sep)]',
  'bg-[var(--scrim)] px-3 py-2 text-sm text-[var(--tx)]',
  'focus:border-[color:var(--accent)] focus:outline-none',
].join(' ')

const isDuplicateNameError = (error: unknown): boolean =>
  error instanceof Error && /already exists|duplicate/i.test(error.message)

export const LibraryInstallDialog = ({
  entry,
  currentUserId,
  organizationId,
  canShareToOrg,
  isOwner,
  onDone,
  onCancel,
}: LibraryInstallDialogProps) => {
  const importEntry = useImportLibraryEntry()
  const createInstance = useCreateInstance()
  const setSecret = useSetInstanceSecret()
  const startOAuth = useStartInstanceOAuth()
  const testInstance = useTestInstance()

  const [audience, setAudience] = useState<'me' | 'organization'>('me')
  const [secret, setSecretValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  // Set once the OAuth tab has been opened; the dialog then waits for the
  // user to finish signing in and offers the final "Test connection" step.
  const [oauthInstanceId, setOauthInstanceId] = useState<string | null>(null)
  const [oauthCatalogEntryId, setOauthCatalogEntryId] = useState<string | null>(null)

  const isOAuth = entry.authMethod === 'oauth2'
  const needsSecret = entry.authMethod !== 'none' && !isOAuth
  const pending =
    importEntry.isPending
    || createInstance.isPending
    || setSecret.isPending
    || startOAuth.isPending
    || testInstance.isPending

  const finishAfterOAuth = async () => {
    if (!oauthInstanceId || !oauthCatalogEntryId) return
    setError(null)
    setProgress('Testing connection…')
    try {
      await testInstance.mutateAsync(oauthInstanceId)
      onDone(oauthCatalogEntryId)
    } catch (caught) {
      setProgress(null)
      setError(
        `Connection test failed: ${
          caught instanceof Error ? caught.message : 'unknown error'
        }. Finish the sign-in in the other tab, then try again.`,
      )
    }
  }

  const runInstall = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (needsSecret && audience === 'me' && !secret.trim()) {
      setError('This connector needs a credential — paste your API key or token.')
      return
    }

    try {
      setProgress('Registering connector…')
      const shareToOrg = audience === 'organization' && isOwner
      let catalogEntry: { id: string } | null = null
      // The catalog name is unique per owner — retry with a suffix so a
      // re-import of the same service never dead-ends the flow.
      for (let attempt = 0; attempt < 3 && !catalogEntry; attempt += 1) {
        try {
          catalogEntry = await importEntry.mutateAsync({
            entry: {
              name: attempt === 0 ? entry.name : `${entry.name}-${attempt + 1}`,
              label: entry.label,
              description: entry.description,
              url: entry.url,
              transport: entry.transport,
              authMethod: entry.authMethod,
              vendor: entry.vendor,
              sourceUrl: entry.sourceUrl,
            },
            shareToOrg,
          })
        } catch (caught) {
          if (!isDuplicateNameError(caught)) throw caught
        }
      }
      if (!catalogEntry) {
        throw new Error('A connector with this name already exists — check "My connectors".')
      }

      setProgress('Installing…')
      const instance = await createInstance.mutateAsync({
        catalogEntryId: catalogEntry.id,
        scopeType: audience === 'organization' ? 'organization' : 'user',
        scopeId: audience === 'organization' ? organizationId : currentUserId,
      })

      if (isOAuth) {
        // Open the provider's sign-in page and switch the dialog to its
        // "waiting for approval" stage.
        setProgress('Starting sign-in…')
        const flow = await startOAuth.mutateAsync({ instanceId: instance.id })
        window.open(flow.authorizationUrl, '_blank', 'noopener')
        setOauthInstanceId(instance.id)
        setOauthCatalogEntryId(catalogEntry.id)
        setProgress(null)
        return
      }

      if (needsSecret && secret.trim()) {
        setProgress('Storing credential…')
        await setSecret.mutateAsync({
          instanceId: instance.id,
          secret: secret.trim(),
          shared: audience === 'organization',
        })
      }

      if (!needsSecret || secret.trim()) {
        setProgress('Testing connection…')
        try {
          await testInstance.mutateAsync(instance.id)
        } catch (caught) {
          setError(
            `Installed, but the connection test failed: ${
              caught instanceof Error ? caught.message : 'unknown error'
            }`,
          )
          setProgress(null)
          return
        }
      }

      onDone(catalogEntry.id)
    } catch (caught) {
      setProgress(null)
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
        onSubmit={(event) => void runInstall(event)}
      >
        <h2 className="text-lg font-semibold text-[var(--tx)]">Add {entry.label}</h2>
        <p className="mt-1 text-sm text-[color:var(--tx3)]">
          {entry.url}
        </p>

        <div className="mt-4 grid gap-3">
          {oauthInstanceId ? (
            <div className="grid gap-2 text-sm text-[color:var(--tx2)]">
              <p>
                A sign-in tab has opened — approve access with your account
                there, then come back and finish the setup.
              </p>
              <p className="text-xs text-[color:var(--tx3)]">
                Didn&apos;t see the tab? Check your popup blocker, then press
                &ldquo;Finish setup&rdquo; to retry.
              </p>
            </div>
          ) : null}
          {!oauthInstanceId && canShareToOrg ? (
            <label className={labelClass}>
              Who is this for?
              <select
                className={inputClass}
                onChange={(event) =>
                  setAudience(event.target.value === 'organization' ? 'organization' : 'me')
                }
                value={audience}
              >
                <option value="me">Just me</option>
                <option value="organization">Whole organisation</option>
              </select>
            </label>
          ) : null}

          {!oauthInstanceId && needsSecret ? (
            <label className={labelClass}>
              {audience === 'organization' ? 'Shared credential' : 'Your API key / token'}
              <input
                autoComplete="new-password"
                className={inputClass}
                onChange={(event) => setSecretValue(event.target.value)}
                placeholder="Paste the key here — it is stored encrypted"
                type="password"
                value={secret}
              />
              {entry.authHint ? (
                <span className="mt-1 block text-xs normal-case tracking-normal text-[color:var(--tx3)]">
                  {entry.authHint}
                </span>
              ) : null}
            </label>
          ) : null}
          {!oauthInstanceId && isOAuth ? (
            <div className="text-sm text-[color:var(--tx2)]">
              You&apos;ll sign in with your existing account — a new tab opens to
              approve access. {entry.authHint ?? ''}
            </div>
          ) : null}
          {!oauthInstanceId && !needsSecret && !isOAuth ? (
            <div className="text-sm text-[color:var(--tx2)]">
              This connector works without a key — it will be tested and its tools
              discovered automatically.
            </div>
          ) : null}

          {progress && !error ? (
            <div className="text-sm text-[color:var(--tx2)]">{progress}</div>
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
          {oauthInstanceId ? (
            <button
              className={[
                'admin-button admin-button-primary rounded-md px-4 py-2',
                'text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40',
              ].join(' ')}
              disabled={pending}
              onClick={() => void finishAfterOAuth()}
              type="button"
            >
              {pending ? progress ?? 'Finishing…' : "I've signed in — finish setup"}
            </button>
          ) : (
            <button
              className={[
                'admin-button admin-button-primary rounded-md px-4 py-2',
                'text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40',
              ].join(' ')}
              disabled={pending}
              type="submit"
            >
              {pending ? progress ?? 'Adding…' : isOAuth ? 'Sign in & add' : 'Add connector'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
