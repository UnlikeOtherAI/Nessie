import { useRef, useState, type FormEvent } from 'react'
import type { AppDetailRecord } from '@nessie/schemas'

import { useAddCustomApp } from '../../../facades/apps/connect-hooks'
import { toFormErrors, type FormErrors } from '../../../facades/forms/form-errors'
import { Dialog } from '../../shared/Dialog'
import { FormField } from '../../shared/FormField'
import { Input } from '../../shared/FormControls'
import { FormActions, FormError } from '../../shared/FormActions'

type CustomAppDialogProps = {
  onAdded: (app: AppDetailRecord) => void
  onClose: () => void
  open: boolean
}

const EMPTY_ERRORS: FormErrors = { fieldErrors: {}, formError: undefined }

/** Discovers a remote app's requirements before its connection is confirmed. */
export const CustomAppDialog = ({ onAdded, onClose, open }: CustomAppDialogProps) => {
  const addCustomApp = useAddCustomApp()
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [errors, setErrors] = useState<FormErrors>(EMPTY_ERRORS)

  const close = () => {
    if (addCustomApp.isPending) return
    setAddress('')
    setErrors(EMPTY_ERRORS)
    setName('')
    onClose()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = address.trim()
    if (!url) {
      setErrors({ fieldErrors: { url: 'Enter the app address.' }, formError: undefined })
      return
    }

    setErrors(EMPTY_ERRORS)
    try {
      const result = await addCustomApp.mutateAsync({
        name: name.trim() || undefined,
        url,
      })
      close()
      onAdded(result.app)
    } catch (caught) {
      const mapped = toFormErrors(caught)
      setErrors({
        fieldErrors: mapped.fieldErrors,
        formError: mapped.formError ?? 'We could not add that app.',
      })
    }
  }

  /**
   * Opens on the first field rather than on the shell's close cross, which
   * precedes the form in the DOM. Each of these dialogs pinned focus before
   * its form moved to `FormField`; the ref was dropped because the field no
   * longer had a fixed id to target, so the dialog began opening on Close and
   * a person had to tab out of it to start typing.
   */
  const initialFieldRef = useRef<HTMLInputElement>(null)

  return (
    <Dialog
      initialFocusRef={initialFieldRef}
      description="Paste the secure address supplied by the app. Nessie will check how it connects, then show you the sign-in details before creating an account."
      dismissDisabled={addCustomApp.isPending}
      onClose={close}
      open={open}
      title="Add a custom app"
    >
      <form className="grid gap-4" onSubmit={submit}>
        <FormField error={errors.fieldErrors.url} label="App address">
          <Input
            autoComplete="url"
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://example.com/mcp"
            type="url"
            value={address}
            ref={initialFieldRef}
          />
        </FormField>
        <FormField
          error={errors.fieldErrors.name}
          label={<>Name <span className="normal-case font-normal text-[color:var(--tx3)]">(optional)</span></>}
        >
          <Input
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Support tools"
            value={name}
          />
        </FormField>
        <FormError>{errors.formError}</FormError>
        <FormActions>
          <button className="admin-button admin-button-secondary" disabled={addCustomApp.isPending} onClick={close} type="button">
            Cancel
          </button>
          <button className="admin-button admin-button-primary" disabled={addCustomApp.isPending} type="submit">
            {addCustomApp.isPending ? 'Adding…' : 'Add app'}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
