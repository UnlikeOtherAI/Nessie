import { useRef, useState, type FormEvent } from 'react'

import { useSetAppConnectionSecret } from '../../../facades/apps/connect-hooks'
import { TabBar } from '../../primitives/TabBar'
import { Dialog } from '../../shared/Dialog'

type AppSecretDialogProps = {
  canShare: boolean
  connectionId: string | null
  onClose: () => void
  onSaved: () => void
}

/** Collects a pending app connection's key without exposing it after submit. */
export const AppSecretDialog = ({ canShare, connectionId, onClose, onSaved }: AppSecretDialogProps) => {
  const secretRef = useRef<HTMLInputElement>(null)
  const setSecret = useSetAppConnectionSecret()
  const [secret, setSecretValue] = useState('')
  // Deliberately NOT a `useTabParam` host (docs/navigation.md §1, "Tab
  // hosts"): this strip is a field of a form inside a modal, not a section of
  // a screen. Its value is answered once and submitted, so putting it in the
  // URL would outlive the dialog, survive its cancellation and collide with
  // the tab of whatever page the dialog was opened from.
  const [credentialScope, setCredentialScope] = useState<'personal' | 'shared'>('personal')
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    if (setSecret.isPending) return
    setError(null)
    setSecretValue('')
    setCredentialScope('personal')
    onClose()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = secret.trim()
    if (!connectionId || !value) {
      setError('Paste the API key or token to continue.')
      return
    }

    // Clear the only plaintext copy before the request can resolve or fail.
    setError(null)
    setSecretValue('')
    try {
      await setSecret.mutateAsync({
        connectionId,
        secret: value,
        shared: credentialScope === 'shared',
      })
      onSaved()
      close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'We could not store that key.')
    }
  }

  return (
    <Dialog
      description="Nessie encrypts this key and never shows it again."
      dismissDisabled={setSecret.isPending}
      initialFocusRef={secretRef}
      onClose={close}
      open={connectionId !== null}
      title="Add an API key"
    >
      <form className="grid gap-4" onSubmit={submit}>
        {canShare ? (
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium text-[color:var(--tx)]">Who can use this key?</legend>
            <TabBar
              ariaLabel="Choose API key access"
              items={[
                { label: 'Personal key', testId: 'app-key-personal', value: 'personal' },
                { label: 'Shared key', testId: 'app-key-shared', value: 'shared' },
              ]}
              onChange={setCredentialScope}
              role="radiogroup"
              size="sm"
              value={credentialScope}
            />
            <p className="text-sm text-[color:var(--tx2)]">
              {credentialScope === 'shared'
                ? 'Everyone who can use this connection may use this API key.'
                : 'Only runs acting for you can use this API key.'}
            </p>
          </fieldset>
        ) : (
          <p className="text-sm text-[color:var(--tx2)]">
            This personal key is available only in runs acting for you.
          </p>
        )}
        <label className="grid gap-1.5 text-sm font-medium text-[color:var(--tx)]" htmlFor="app-secret">
          API key or token
          <input
            autoComplete="new-password"
            className="admin-input"
            id="app-secret"
            onChange={(event) => setSecretValue(event.target.value)}
            ref={secretRef}
            type="password"
            value={secret}
          />
        </label>
        {error ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button className="admin-button admin-button-secondary" disabled={setSecret.isPending} onClick={close} type="button">
            Cancel
          </button>
          <button className="admin-button admin-button-primary" disabled={setSecret.isPending} type="submit">
            {setSecret.isPending ? 'Saving…' : 'Save key'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
