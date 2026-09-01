import { useRef, useState, type FormEvent } from 'react'

import type { ProjectRecord } from '../../../lib/api-client'
import type { CreateSecretInput } from '../../../facades/secrets/hooks'
import { Dialog } from '../../shared/Dialog'

type CreateSecretDialogProps = {
  onClose: () => void
  onCreate: (input: CreateSecretInput) => Promise<unknown>
  onSaved: () => void
  open: boolean
  pending: boolean
  projects: ProjectRecord[]
}

type SecretCreationScope = 'personal' | 'project'

type SecretFormValues = {
  name: string
  scopeId: string
  scopeType: SecretCreationScope
  value: string
}

const secretNameIsValid = (name: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(name)

export const buildSecretCreateInput = ({
  name,
  scopeId,
  scopeType,
  value,
}: SecretFormValues): CreateSecretInput | null => {
  const normalizedName = name.trim().toUpperCase()
  if (!secretNameIsValid(normalizedName) || !value || (scopeType === 'project' && !scopeId)) {
    return null
  }
  return {
    name: normalizedName,
    value,
    scopeType,
    ...(scopeType === 'project' ? { scopeId } : {}),
  }
}

/**
 * The settings entry point for a new vault secret. The mutation remains owned
 * by the secrets facade at the page boundary; this dialog owns only the
 * temporary form state, including the secret value until it is submitted.
 */
export const CreateSecretDialog = ({
  onClose,
  onCreate,
  onSaved,
  open,
  pending,
  projects,
}: CreateSecretDialogProps) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [scopeType, setScopeType] = useState<SecretCreationScope>('personal')
  const [scopeId, setScopeId] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const resetForm = () => {
    setName('')
    setValue('')
    setScopeType('personal')
    setScopeId('')
    setFormError(null)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = buildSecretCreateInput({ name, scopeId, scopeType, value })
    if (!input) return

    setFormError(null)
    try {
      await onCreate(input)
      resetForm()
      onSaved()
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'Could not save secret.')
    }
  }

  const canSave = Boolean(buildSecretCreateInput({ name, scopeId, scopeType, value }))

  return (
    <Dialog
      description="Secret values go directly to Infisical and are never stored in Nessie, chat, or agent context."
      dismissDisabled={pending}
      initialFocusRef={nameInputRef}
      onClose={handleClose}
      open={open}
      title="Save a secret"
    >
      <form className="grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="grid gap-1.5">
          <label
            className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]"
            htmlFor="secret-name"
          >
            Secret key
          </label>
          <input
            ref={nameInputRef}
            autoComplete="off"
            className="admin-input"
            id="secret-name"
            onChange={(event) => setName(event.target.value.toUpperCase())}
            placeholder="STRIPE_API_KEY"
            value={name}
          />
          <p className="text-xs text-[color:var(--tx3)]">
            Use uppercase letters, numbers, and underscores.
          </p>
        </div>

        <div className="grid gap-1.5">
          <label
            className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]"
            htmlFor="secret-value"
          >
            Value
          </label>
          <input
            autoComplete="off"
            className="admin-input"
            id="secret-value"
            onChange={(event) => setValue(event.target.value)}
            type="password"
            value={value}
          />
        </div>

        <div className="grid gap-1.5">
          <label
            className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]"
            htmlFor="secret-scope"
          >
            Scope
          </label>
          <select
            className="admin-input"
            id="secret-scope"
            onChange={(event) => setScopeType(event.target.value as SecretCreationScope)}
            value={scopeType}
          >
            <option value="personal">Personal</option>
            <option value="project">Project</option>
          </select>
        </div>

        {scopeType === 'project' ? (
          <div className="grid gap-1.5">
            <label
              className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]"
              htmlFor="secret-project"
            >
              Project
            </label>
            <select
              className="admin-input"
              id="secret-project"
              onChange={(event) => setScopeId(event.target.value)}
              required
              value={scopeId}
            >
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>
        ) : null}

        {formError ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{formError}</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <button className="admin-button admin-button-secondary" onClick={handleClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={pending || !canSave}
            type="submit"
          >
            {pending ? 'Saving…' : 'Save securely'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
