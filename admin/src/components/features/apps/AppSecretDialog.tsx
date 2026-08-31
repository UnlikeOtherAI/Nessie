import { useRef, useState, type FormEvent } from 'react'

import { useSetAppConnectionSecret } from '../../../facades/apps/connect-hooks'
import { Dialog } from '../../shared/Dialog'

type AppSecretDialogProps = {
  connectionId: string | null
  onClose: () => void
  onSaved: () => void
}

/** Collects a pending app connection's key without exposing it after submit. */
export const AppSecretDialog = ({ connectionId, onClose, onSaved }: AppSecretDialogProps) => {
  const secretRef = useRef<HTMLInputElement>(null)
  const setSecret = useSetAppConnectionSecret()
  const [secret, setSecretValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    if (setSecret.isPending) return
    setError(null)
    setSecretValue('')
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
      await setSecret.mutateAsync({ connectionId, secret: value })
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
