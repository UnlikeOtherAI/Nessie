import { useRef, useState, type FormEvent } from 'react'
import type { AppDetailRecord } from '@nessie/schemas'

import { useAddCustomApp } from '../../../facades/apps/connect-hooks'
import { Dialog } from '../../shared/Dialog'

type CustomAppDialogProps = {
  onAdded: (app: AppDetailRecord) => void
  onClose: () => void
  open: boolean
}

/** Discovers a remote app's requirements before its connection is confirmed. */
export const CustomAppDialog = ({ onAdded, onClose, open }: CustomAppDialogProps) => {
  const addressRef = useRef<HTMLInputElement>(null)
  const addCustomApp = useAddCustomApp()
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    if (addCustomApp.isPending) return
    setAddress('')
    setError(null)
    setName('')
    onClose()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = address.trim()
    if (!url) {
      setError('Enter the app address.')
      return
    }

    setError(null)
    try {
      const result = await addCustomApp.mutateAsync({
        name: name.trim() || undefined,
        url,
      })
      close()
      onAdded(result.app)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'We could not add that app.')
    }
  }

  return (
    <Dialog
      description="Paste the secure address supplied by the app. Nessie will check how it connects, then show you the sign-in details before creating an account."
      dismissDisabled={addCustomApp.isPending}
      initialFocusRef={addressRef}
      onClose={close}
      open={open}
      title="Add a custom app"
    >
      <form className="grid gap-4" onSubmit={submit}>
        <label className="grid gap-1.5 text-sm font-medium text-[color:var(--tx)]" htmlFor="custom-app-address">
          App address
          <input
            autoComplete="url"
            className="admin-input"
            id="custom-app-address"
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://example.com/mcp"
            ref={addressRef}
            type="url"
            value={address}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-[color:var(--tx)]" htmlFor="custom-app-name">
          Name <span className="font-normal text-[color:var(--tx3)]">(optional)</span>
          <input
            autoComplete="off"
            className="admin-input"
            id="custom-app-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Support tools"
            value={name}
          />
        </label>
        {error ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button className="admin-button admin-button-secondary" disabled={addCustomApp.isPending} onClick={close} type="button">
            Cancel
          </button>
          <button className="admin-button admin-button-primary" disabled={addCustomApp.isPending} type="submit">
            {addCustomApp.isPending ? 'Adding…' : 'Add app'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
