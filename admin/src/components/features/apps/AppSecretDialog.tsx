import { useRef, useState, type FormEvent } from 'react'

import { useSetAppConnectionSecret } from '../../../facades/apps/connect-hooks'
import { toFormErrors, type FormErrors } from '../../../facades/form-errors'
import { TabBar } from '../../primitives/TabBar'
import { Dialog } from '../../shared/Dialog'
import { FormField } from '../../shared/FormField'
import { Input } from '../../shared/FormControls'
import { FormActions, FormError } from '../../shared/FormActions'

type AppSecretDialogProps = {
  canShare: boolean
  connectionId: string | null
  onClose: () => void
  onSaved: () => void
}

const EMPTY_ERRORS: FormErrors = { fieldErrors: {}, formError: undefined }

/** Collects a pending app connection's key without exposing it after submit. */
export const AppSecretDialog = ({ canShare, connectionId, onClose, onSaved }: AppSecretDialogProps) => {
  const setSecret = useSetAppConnectionSecret()
  const [secret, setSecretValue] = useState('')
  // Deliberately NOT a `useTabParam` host (docs/navigation/overview.md §1, "Tab
  // hosts"): this strip is a field of a form inside a modal, not a section of
  // a screen. Its value is answered once and submitted, so putting it in the
  // URL would outlive the dialog, survive its cancellation and collide with
  // the tab of whatever page the dialog was opened from.
  const [credentialScope, setCredentialScope] = useState<'personal' | 'shared'>('personal')
  const [errors, setErrors] = useState<FormErrors>(EMPTY_ERRORS)

  const close = () => {
    if (setSecret.isPending) return
    setErrors(EMPTY_ERRORS)
    setSecretValue('')
    setCredentialScope('personal')
    onClose()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = secret.trim()
    if (!connectionId || !value) {
      setErrors({ fieldErrors: { secret: 'Paste the API key or token to continue.' }, formError: undefined })
      return
    }

    // Clear the only plaintext copy before the request can resolve or fail.
    setErrors(EMPTY_ERRORS)
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
      const mapped = toFormErrors(caught)
      setErrors({
        fieldErrors: mapped.fieldErrors,
        formError: mapped.formError ?? 'We could not store that key.',
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
      description="Nessie encrypts this key and never shows it again."
      dismissDisabled={setSecret.isPending}
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
        <FormField error={errors.fieldErrors.secret} label="API key or token">
          <Input
            autoComplete="new-password"
            onChange={(event) => setSecretValue(event.target.value)}
            type="password"
            value={secret}
            ref={initialFieldRef}
          />
        </FormField>
        <FormError>{errors.formError}</FormError>
        <FormActions>
          <button className="admin-button admin-button-secondary" disabled={setSecret.isPending} onClick={close} type="button">
            Cancel
          </button>
          <button className="admin-button admin-button-primary" disabled={setSecret.isPending} type="submit">
            {setSecret.isPending ? 'Saving…' : 'Save key'}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
