import { useRef, useState, type FormEvent } from 'react'
import { maskSecretValue } from '@nessie/schemas'

import {
  useTransientSecretSave,
  type SecretRecord,
  type SecretScopeType,
} from '../../../facades/secrets/hooks'
import {
  currentSecretCaptureItem,
  type SecretCapture,
} from './secret-capture'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input, Select } from '../../shared/FormControls'

const newCaptureRequestId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`

export const suggestedSecretName = (
  type: ReturnType<typeof currentSecretCaptureItem>['detected']['type'],
): string => {
  switch (type) {
    case 'stripe_api_key': return 'STRIPE_API_KEY'
    case 'github_token': return 'GITHUB_TOKEN'
    case 'openai_api_key': return 'OPENAI_API_KEY'
    case 'anthropic_api_key': return 'ANTHROPIC_API_KEY'
    case 'aws_access_key': return 'AWS_ACCESS_KEY_ID'
    case 'database_url': return 'DATABASE_URL'
    case 'google_api_key': return 'GOOGLE_API_KEY'
    case 'sendgrid_api_key': return 'SENDGRID_API_KEY'
    case 'slack_token': return 'SLACK_TOKEN'
    default: return 'SERVICE_SECRET'
  }
}

const suggestedCaptureName = (capture: SecretCapture): string => {
  const item = currentSecretCaptureItem(capture)
  const base = suggestedSecretName(item.detected.type)
  const occurrence = capture.items
    .slice(0, capture.currentIndex + 1)
    .filter((candidate) => suggestedSecretName(candidate.detected.type) === base)
    .length
  return occurrence > 1 ? `${base}_${occurrence}` : base
}

export const SecretCaptureDialog = ({
  capture,
  onClose,
  onSaved,
}: {
  capture: SecretCapture
  onClose: () => void
  onSaved: (
    secret: SecretRecord,
    identity: { captureId: string; currentIndex: number },
  ) => Promise<void>
}) => {
  const saveSecret = useTransientSecretSave()
  const item = currentSecretCaptureItem(capture)
  const [name, setName] = useState(() => suggestedCaptureName(capture))
  const [scopeType, setScopeType] = useState<SecretScopeType>(capture.scopeType)
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [savedSecret, setSavedSecret] = useState<SecretRecord | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const pendingRef = useRef(false)
  const saveRequestIdRef = useRef(newCaptureRequestId())

  const updateName = (nextName: string) => {
    saveRequestIdRef.current = newCaptureRequestId()
    setName(nextName.toUpperCase())
  }

  const updateScopeType = (nextScopeType: SecretScopeType) => {
    saveRequestIdRef.current = newCaptureRequestId()
    setScopeType(nextScopeType)
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pendingRef.current) return
    pendingRef.current = true
    setIsPending(true)
    setError(null)
    let secret = savedSecret
    if (!secret) {
      try {
        secret = await saveSecret(
          {
            name,
            value: item.value,
            scopeType,
            ...(scopeType === 'project' && capture.scopeId ? { scopeId: capture.scopeId } : {}),
          },
          saveRequestIdRef.current,
        )
        setSavedSecret(secret)
      } catch {
        setError('Could not save this secret. Check the name and vault connection, then try again.')
        pendingRef.current = false
        setIsPending(false)
        return
      }
    }

    try {
      await onSaved(secret, {
        captureId: capture.captureId,
        currentIndex: capture.currentIndex,
      })
    } catch {
      setError('The secret was saved, but the protected message could not be sent. Try again.')
    } finally {
      pendingRef.current = false
      setIsPending(false)
    }
  }

  return (
    <Dialog
      blocking
      description="The raw value was stopped before chat, storage, or an agent could receive it. Saving sends only the obscured replacement."
      dismissDisabled={isPending}
      initialFocusRef={nameRef}
      onClose={onClose}
      open
      title={capture.items.length === 1
        ? 'Nessie detected a credential'
        : `Credential ${capture.currentIndex + 1} of ${capture.items.length}`}
    >
      <form className="grid gap-4" onSubmit={(event) => void save(event)}>
        <FormField label="Secret key">
          <Input
            autoComplete="off"
            disabled={isPending || savedSecret !== null}
            onChange={(event) => updateName(event.target.value)}
            ref={nameRef}
            value={name}
          />
        </FormField>
        <FormField help="Only the credential type stays visible; secret bytes are bullets." label="Value">
          <Input
            autoComplete="off"
            mono
            readOnly
            value={maskSecretValue(item.value, item.detected.type)}
          />
        </FormField>
        <FormField label="Scope">
          <Select
            disabled={isPending || savedSecret !== null}
            onChange={(event) => updateScopeType(event.target.value as SecretScopeType)}
            value={scopeType}
          >
            <option value="personal">Personal</option>
            {capture.scopeId ? <option value="project">This project</option> : null}
          </Select>
        </FormField>
        <FormError>{error}</FormError>
        <FormActions>
          <button
            className="admin-button admin-button-secondary"
            disabled={isPending}
            onClick={onClose}
            type="button"
          >
            Discard
          </button>
          <button className="admin-button admin-button-primary" disabled={isPending || !/^[A-Z][A-Z0-9_]*$/.test(name)} type="submit">
            {isPending
              ? savedSecret ? 'Sending…' : 'Saving…'
              : savedSecret ? 'Retry protected message' : 'Save securely'}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
