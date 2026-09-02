import { useState, type FormEvent } from 'react'

import type { CloudBrowserScope } from '../../../lib/api-client'
import { SectionLabel } from '../../primitives/SectionLabel'
import { FormError, FormSuccess } from '../../shared/FormActions'
import { useConnectCloudBrowser } from '../../../facades/browser-cloud/hooks'

type CloudBrowserConnectionFormProps = {
  scope: CloudBrowserScope
  /** Required at team scope: which team the account belongs to. */
  teamId?: string | null
  /** Shown above the fields; each scope explains itself differently. */
  blurb: string
  connected: boolean
  onDone?: () => void
}

/**
 * The one connect form, used by both scopes.
 *
 * The scope is a prop rather than a control: which account a key belongs to is
 * decided by the surface that accepted it — the owner-only organisation or
 * team settings, or a person's own account settings — because Browserbase
 * authenticates by API key alone and nothing about a key says whose it is.
 */
export const CloudBrowserConnectionForm = ({
  scope,
  teamId = null,
  blurb,
  connected,
  onDone,
}: CloudBrowserConnectionFormProps) => {
  const connect = useConnectCloudBrowser()
  const [apiKey, setApiKey] = useState('')
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setNotice(null)
    connect.mutate(
      {
        apiKey: apiKey.trim(),
        projectId: projectId.trim(),
        scope,
        ...(teamId ? { teamId } : {}),
      },
      {
        onError: (cause: unknown) => {
          setError(
            cause instanceof Error
              ? cause.message
              : 'That key could not be verified with Browserbase.',
          )
        },
        onSuccess: () => {
          setApiKey('')
          setProjectId('')
          setNotice(connected ? 'Key replaced.' : 'Connected.')
          onDone?.()
        },
      },
    )
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={submit}>
      <p className="text-sm text-[color:var(--tx2)]">{blurb}</p>
      <label className="grid gap-1">
        <SectionLabel as="span" size="xs">Project ID</SectionLabel>
        <input
          autoComplete="off"
          className="admin-input"
          onChange={(event) => setProjectId(event.target.value)}
          placeholder="From your Browserbase dashboard"
          required
          value={projectId}
        />
      </label>
      <label className="grid gap-1">
        <SectionLabel as="span" size="xs">API key</SectionLabel>
        <input
          autoComplete="off"
          className="admin-input"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={connected ? 'Enter a new key to replace the stored one' : 'bb_…'}
          required
          type="password"
          value={apiKey}
        />
      </label>
      <p className="text-xs text-[color:var(--tx3)]">
        The key is stored encrypted and never shown again. Browsers opened with it run on
        Browserbase’s infrastructure, so the pages an agent visits — and any sessions it is
        signed in to — live in that account.
      </p>
      <div className="flex items-center gap-3">
        <button
          className="admin-button admin-button-primary admin-button-compact"
          disabled={connect.isPending || apiKey.trim() === '' || projectId.trim() === ''}
          type="submit"
        >
          {connect.isPending
            ? 'Verifying…'
            : connected ? 'Replace key' : 'Connect'}
        </button>
        <span className="text-xs text-[color:var(--tx3)]">
          We open and close one browser to check the key before saving it.
        </span>
      </div>
      <FormError>{error}</FormError>
      <FormSuccess>{notice}</FormSuccess>
    </form>
  )
}
