import { useRef, useState, type FormEvent } from 'react'
import { maskSecretValue } from '@nessie/schemas'

import {
  useCreateSecret,
  type SecretRecord,
  type SecretScopeType,
} from '../../../facades/secrets/hooks'
import type { SecretCapture } from './useChannelComposer'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input, Select } from '../../shared/FormControls'

export const suggestedSecretName = (type: SecretCapture['detected']['type']): string => {
  switch (type) {
    case 'stripe_api_key': return 'STRIPE_API_KEY'
    case 'github_token': return 'GITHUB_TOKEN'
    case 'openai_api_key': return 'OPENAI_API_KEY'
    case 'anthropic_api_key': return 'ANTHROPIC_API_KEY'
    case 'aws_access_key': return 'AWS_ACCESS_KEY_ID'
    case 'database_url': return 'DATABASE_URL'
    default: return 'SERVICE_SECRET'
  }
}

export const SecretCaptureDialog = ({
  capture,
  onClose,
  onSaved,
}: {
  capture: SecretCapture
  onClose: () => void
  onSaved: (secret: SecretRecord) => Promise<void>
}) => {
  const createSecret = useCreateSecret()
  const [name, setName] = useState(() => suggestedSecretName(capture.detected.type))
  const [scopeType, setScopeType] = useState<SecretScopeType>(capture.scopeType)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    try {
      const secret = await createSecret.mutateAsync({
        name,
        value: capture.value,
        scopeType,
        ...(scopeType === 'project' && capture.scopeId ? { scopeId: capture.scopeId } : {}),
      })
      await onSaved(secret)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this secret.')
    }
  }

  return (
    <Dialog
      description="The raw value was stopped before chat, storage, or an agent could receive it. Saving sends only the obscured replacement."
      dismissDisabled={createSecret.isPending}
      initialFocusRef={nameRef}
      onClose={onClose}
      open
      title="Nessie detected a credential"
    >
      <form className="grid gap-4" onSubmit={(event) => void save(event)}>
        <FormField label="Secret key">
          <Input
            autoComplete="off"
            onChange={(event) => setName(event.target.value.toUpperCase())}
            ref={nameRef}
            value={name}
          />
        </FormField>
        <FormField help="Only the credential type stays visible; secret bytes are bullets." label="Value">
          <Input
            autoComplete="off"
            mono
            readOnly
            value={maskSecretValue(capture.value, capture.detected.type)}
          />
        </FormField>
        <FormField label="Scope">
          <Select
            onChange={(event) => setScopeType(event.target.value as SecretScopeType)}
            value={scopeType}
          >
            <option value="personal">Personal</option>
            {capture.scopeId ? <option value="project">This project</option> : null}
          </Select>
        </FormField>
        <FormError>{error}</FormError>
        <FormActions>
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">Discard</button>
          <button className="admin-button admin-button-primary" disabled={createSecret.isPending || !/^[A-Z][A-Z0-9_]*$/.test(name)} type="submit">
            {createSecret.isPending ? 'Saving…' : 'Save securely'}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
