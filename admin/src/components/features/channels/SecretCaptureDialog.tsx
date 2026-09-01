import { useState } from 'react'

import { useCreateSecret, type SecretScopeType } from '../../../facades/secrets/hooks'
import type { SecretCapture } from './useChannelComposer'

const suggestedName = (type: SecretCapture['detected']['type']): string => {
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
}: {
  capture: SecretCapture
  onClose: () => void
}) => {
  const createSecret = useCreateSecret()
  const [name, setName] = useState(() => suggestedName(capture.detected.type))
  const [scopeType, setScopeType] = useState<SecretScopeType>(capture.scopeType)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setError(null)
    try {
      await createSecret.mutateAsync({
        name,
        value: capture.value,
        scopeType,
        ...(scopeType === 'project' && capture.scopeId ? { scopeId: capture.scopeId } : {}),
      })
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this secret.')
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="presentation">
      <section aria-labelledby="secret-capture-title" className="admin-card w-full max-w-md p-5" role="dialog" aria-modal="true">
        <h2 className="text-lg font-semibold text-[color:var(--tx)]" id="secret-capture-title">
          Nessie detected a credential
        </h2>
        <p className="mt-2 text-sm text-[color:var(--tx2)]">
          It was not sent to chat. Save it to the vault instead; agents will never receive its value.
        </p>
        <label className="mt-4 grid gap-1 text-sm text-[color:var(--tx2)]">
          Value
          <input className="admin-input" readOnly type="password" value={capture.value} />
        </label>
        <label className="mt-3 grid gap-1 text-sm text-[color:var(--tx2)]">
          Name
          <input className="admin-input" onChange={(event) => setName(event.target.value.toUpperCase())} value={name} />
        </label>
        <label className="mt-3 grid gap-1 text-sm text-[color:var(--tx2)]">
          Scope
          <select className="admin-input" onChange={(event) => setScopeType(event.target.value as SecretScopeType)} value={scopeType}>
            <option value="personal">Personal</option>
            {capture.scopeId ? <option value="project">This project</option> : null}
          </select>
        </label>
        {error ? <p className="mt-3 text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">Discard</button>
          <button className="admin-button admin-button-primary" disabled={createSecret.isPending || !/^[A-Z][A-Z0-9_]*$/.test(name)} onClick={() => void save()} type="button">
            {createSecret.isPending ? 'Saving…' : 'Save securely'}
          </button>
        </div>
      </section>
    </div>
  )
}
