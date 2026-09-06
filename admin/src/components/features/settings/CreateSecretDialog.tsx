import { useRef, useState, type FormEvent } from 'react'
import type { SecretScopeType } from '@nessie/schemas'

import type { ProjectRecord } from '../../../lib/api-client'
import type { CreateSecretInput } from '../../../facades/secrets/hooks'
import { SECRET_SCOPE_LABEL, type SecretPageScope } from './SecretMetadataTable'
import { toFormErrors } from '../../../facades/forms/form-errors'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input, Select } from '../../shared/FormControls'
import { Switch } from '../../primitives/Switch'

type CreateSecretDialogProps = {
  onClose: () => void
  onCreate: (input: CreateSecretInput) => Promise<unknown>
  onSaved: () => void
  open: boolean
  /** The page's level; it decides which scopes this form may write into. */
  pageScope: SecretPageScope
  pending: boolean
  projects: ProjectRecord[]
  /** The organisation or team the page is standing in. Unused at personal scope. */
  scopeId: string
}

/** The scopes each page may create into. A page never writes above its own level. */
export const SECRET_CREATION_SCOPES: Record<SecretPageScope, readonly SecretScopeType[]> = {
  organization: ['organization'],
  personal: ['personal', 'project'],
  team: ['team'],
}

type SecretFormValues = {
  locked: boolean
  name: string
  scopeId: string
  scopeType: SecretScopeType
  value: string
}

const secretNameIsValid = (name: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(name)

/**
 * A lock is only meaningful where something sits below. `personal` is the
 * bottom of the chain, so the switch is absent there rather than present and
 * ignored — the API refuses `locked` on a personal secret outright.
 */
export const scopeCanLock = (scopeType: SecretScopeType): boolean => scopeType !== 'personal'

export const buildSecretCreateInput = ({
  locked,
  name,
  scopeId,
  scopeType,
  value,
}: SecretFormValues): CreateSecretInput | null => {
  const normalizedName = name.trim().toUpperCase()
  const scopeIdRequired = scopeType !== 'personal'
  if (!secretNameIsValid(normalizedName) || !value || (scopeIdRequired && !scopeId)) {
    return null
  }
  return {
    name: normalizedName,
    value,
    scopeType,
    ...(scopeIdRequired ? { scopeId } : {}),
    ...(locked && scopeCanLock(scopeType) ? { locked: true } : {}),
  }
}

const lockCopy: Partial<Record<SecretScopeType, string>> = {
  organization: 'Teams and people below cannot save their own; they still see this one, greyed out.',
  project: 'Teams and people below cannot save their own; they still see this one, greyed out.',
  team: 'People in this team cannot save their own; they still see this one, greyed out.',
}

/**
 * The settings entry point for a new vault secret, used by all three Secrets
 * pages. The mutation remains owned by the secrets facade at the page boundary;
 * this dialog owns only the temporary form state, including the secret value
 * until it is submitted.
 *
 * A page never offers a scope above its own: the organisation page writes
 * organisation secrets, the team page its team's, and the personal page a
 * person's own (or a project's). That is why there is no scope picker on the
 * two upper pages — the page *is* the scope, which is also why their tables
 * dropped the Scope column.
 */
export const CreateSecretDialog = ({
  onClose,
  onCreate,
  onSaved,
  open,
  pageScope,
  pending,
  projects,
  scopeId: pageScopeId,
}: CreateSecretDialogProps) => {
  const scopes = SECRET_CREATION_SCOPES[pageScope]
  const defaultScope = scopes[0] as SecretScopeType
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [scopeType, setScopeType] = useState<SecretScopeType>(defaultScope)
  const [projectId, setProjectId] = useState('')
  const [locked, setLocked] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // A project secret names a project the person picks; every other non-personal
  // scope is the page's own level and is not a choice.
  const scopeId = scopeType === 'project' ? projectId : pageScopeId

  const resetForm = () => {
    setName('')
    setValue('')
    setScopeType(defaultScope)
    setProjectId('')
    setLocked(false)
    setFormError(null)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = buildSecretCreateInput({ locked, name, scopeId, scopeType, value })
    if (!input) return

    setFormError(null)
    try {
      await onCreate(input)
      resetForm()
      onSaved()
    } catch (caught) {
      setFormError(toFormErrors(caught).formError ?? 'Could not save secret.')
    }
  }

  const canSave = Boolean(buildSecretCreateInput({ locked, name, scopeId, scopeType, value }))

  /**
   * Opens the dialog on the first field rather than on whatever the shell
   * finds first — which is the close cross, since it precedes the form in the
   * DOM. The dialog carried this before the form moved to `FormField`; it was
   * dropped because the field no longer had a fixed id to target, and a person
   * opening "New secret" then had to tab out of Close to start typing.
   */
  const nameRef = useRef<HTMLInputElement>(null)

  return (
    <Dialog
      description="Secret values go directly to Infisical and are never stored in Nessie, chat, or agent context."
      dismissDisabled={pending}
      initialFocusRef={nameRef}
      onClose={handleClose}
      open={open}
      title="New secret"
    >
      <form className="grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
        <FormField help="Use uppercase letters, numbers, and underscores." label="Secret key">
          <Input
            autoComplete="off"
            onChange={(event) => setName(event.target.value.toUpperCase())}
            placeholder="STRIPE_API_KEY"
            ref={nameRef}
            value={name}
          />
        </FormField>

        <FormField label="Value">
          <Input
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
            type="password"
            value={value}
          />
        </FormField>

        {scopes.length > 1 ? (
          <FormField label="Scope">
            <Select
              onChange={(event) => setScopeType(event.target.value as SecretScopeType)}
              value={scopeType}
            >
              {scopes.map((scope) => (
                <option key={scope} value={scope}>{SECRET_SCOPE_LABEL[scope]}</option>
              ))}
            </Select>
          </FormField>
        ) : null}

        {scopeType === 'project' ? (
          <FormField label="Project" required>
            <Select
              onChange={(event) => setProjectId(event.target.value)}
              required
              value={projectId}
            >
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </Select>
          </FormField>
        ) : null}

        {scopeCanLock(scopeType) ? (
          <div className="flex items-start gap-3">
            <Switch
              checked={locked}
              label="Use this everywhere"
              onChange={setLocked}
            />
            <div className="grid gap-0.5 text-sm">
              <span className="text-[color:var(--tx2)]">Use this everywhere</span>
              <span className="text-[color:var(--tx3)]">{lockCopy[scopeType]}</span>
            </div>
          </div>
        ) : null}

        <FormError>{formError}</FormError>

        <FormActions>
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
        </FormActions>
      </form>
    </Dialog>
  )
}
