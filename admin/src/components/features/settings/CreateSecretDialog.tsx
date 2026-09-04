import { useRef, useState, type FormEvent } from 'react'

import type { ProjectRecord } from '../../../lib/api-client'
import type { CreateSecretInput } from '../../../facades/secrets/hooks'
import { toFormErrors } from '../../../facades/form-errors'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input, Select } from '../../shared/FormControls'

type CreateSecretDialogProps = {
  onClose: () => void
  onCreate: (input: CreateSecretInput, idempotencyKey: string) => Promise<unknown>
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

const newCaptureId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`

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
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [scopeType, setScopeType] = useState<SecretCreationScope>('personal')
  const [scopeId, setScopeId] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const requestIdRef = useRef(newCaptureId())

  const changed = (apply: () => void) => {
    requestIdRef.current = newCaptureId()
    apply()
  }

  const resetForm = () => {
    setName('')
    setValue('')
    setScopeType('personal')
    setScopeId('')
    setFormError(null)
    requestIdRef.current = newCaptureId()
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
      await onCreate(input, requestIdRef.current)
      resetForm()
      onSaved()
    } catch (caught) {
      setFormError(toFormErrors(caught).formError ?? 'Could not save secret.')
    }
  }

  const canSave = Boolean(buildSecretCreateInput({ name, scopeId, scopeType, value }))

  /**
   * Opens the dialog on the first field rather than on whatever the shell
   * finds first — which is the close cross, since it precedes the form in the
   * DOM. The dialog carried this before the form moved to `FormField`; it was
   * dropped because the field no longer had a fixed id to target, and a person
   * opening "Save a secret" then had to tab out of Close to start typing.
   */
  const nameRef = useRef<HTMLInputElement>(null)

  return (
    <Dialog
      description="Secret values go directly to Infisical and are never stored in Nessie, chat, or agent context."
      dismissDisabled={pending}
      initialFocusRef={nameRef}
      onClose={handleClose}
      open={open}
      title="Save a secret"
    >
      <form className="grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
        <FormField help="Use uppercase letters, numbers, and underscores." label="Secret key">
          <Input
            autoComplete="off"
            disabled={pending}
            onChange={(event) => changed(() => setName(event.target.value.toUpperCase()))}
            placeholder="STRIPE_API_KEY"
            ref={nameRef}
            value={name}
          />
        </FormField>

        <FormField label="Value">
          <Input
            autoComplete="off"
            disabled={pending}
            onChange={(event) => changed(() => setValue(event.target.value))}
            type="password"
            value={value}
          />
        </FormField>

        <FormField label="Scope">
          <Select
            disabled={pending}
            onChange={(event) => changed(() => {
              setScopeType(event.target.value as SecretCreationScope)
            })}
            value={scopeType}
          >
            <option value="personal">Personal</option>
            <option value="project">Project</option>
          </Select>
        </FormField>

        {scopeType === 'project' ? (
          <FormField label="Project" required>
            <Select
              disabled={pending}
              onChange={(event) => changed(() => setScopeId(event.target.value))}
              required
              value={scopeId}
            >
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </Select>
          </FormField>
        ) : null}

        <FormError>{formError}</FormError>

        <FormActions>
          <button
            className="admin-button admin-button-secondary"
            disabled={pending}
            onClick={handleClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={pending || !canSave}
            type="submit"
          >
            {pending ? 'Saving…' : 'Save securely'}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
