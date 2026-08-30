import { useState, type FormEvent } from 'react'

import { useProjects } from '../../facades/projects/hooks'
import {
  useCreateSecret,
  useRevokeSecret,
  useSecrets,
  type SecretScopeType,
} from '../../facades/secrets/hooks'
import { FeedbackBanner, SettingsPanel, type SettingsFeedback } from './settings-shared'

const scopeLabel: Record<SecretScopeType, string> = {
  personal: 'Personal',
  project: 'Project',
  team: 'Team',
  workspace: 'Workspace',
}

export const SecretsPage = () => {
  const { data: secrets = [], isLoading } = useSecrets()
  const { data: projects = [] } = useProjects()
  const createSecret = useCreateSecret()
  const revokeSecret = useRevokeSecret()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [scopeType, setScopeType] = useState<SecretScopeType>('personal')
  const [scopeId, setScopeId] = useState('')
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFeedback(null)
    try {
      await createSecret.mutateAsync({
        name: name.trim().toUpperCase(),
        value,
        scopeType,
        ...(scopeType === 'project' ? { scopeId } : {}),
      })
      setName('')
      setValue('')
      setFeedback({ kind: 'success', message: 'Saved to the vault. Nessie retained only its metadata.' })
    } catch (caught) {
      setFeedback({ kind: 'error', message: caught instanceof Error ? caught.message : 'Could not save secret.' })
    }
  }

  return (
    <SettingsPanel eyebrow="Security" title="Secrets">
      <div className="grid max-w-3xl gap-4">
        <section className="admin-card p-4">
          <h2 className="font-semibold text-[color:var(--tx)]">Save a secret</h2>
          <p className="mt-1 text-sm text-[color:var(--tx2)]">
            Secret values go directly to Infisical and are never stored in Nessie, chat, or agent context.
          </p>
          <form className="mt-4 grid gap-3" onSubmit={(event) => void submit(event)}>
            <label className="grid gap-1 text-sm text-[color:var(--tx2)]">Name
              <input className="admin-input" onChange={(event) => setName(event.target.value)} placeholder="STRIPE_API_KEY" value={name} />
            </label>
            <label className="grid gap-1 text-sm text-[color:var(--tx2)]">Value
              <input autoComplete="off" className="admin-input" onChange={(event) => setValue(event.target.value)} type="password" value={value} />
            </label>
            <label className="grid gap-1 text-sm text-[color:var(--tx2)]">Scope
              <select className="admin-input" onChange={(event) => setScopeType(event.target.value as SecretScopeType)} value={scopeType}>
                <option value="personal">Personal</option>
                <option value="project">Project</option>
              </select>
            </label>
            {scopeType === 'project' ? (
              <label className="grid gap-1 text-sm text-[color:var(--tx2)]">Project
                <select className="admin-input" onChange={(event) => setScopeId(event.target.value)} required value={scopeId}>
                  <option value="">Choose a project</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
            ) : null}
            <button className="admin-button admin-button-primary justify-self-start" disabled={createSecret.isPending || !/^[A-Z][A-Z0-9_]*$/.test(name.trim().toUpperCase()) || value.length === 0 || (scopeType === 'project' && !scopeId)} type="submit">
              {createSecret.isPending ? 'Saving…' : 'Save securely'}
            </button>
          </form>
          <FeedbackBanner feedback={feedback} />
        </section>
        <section className="admin-card p-4">
          <h2 className="font-semibold text-[color:var(--tx)]">Available secrets</h2>
          <p className="mt-1 text-sm text-[color:var(--tx2)]">Values are intentionally never displayed.</p>
          <div className="mt-3 grid gap-2">
            {isLoading ? <p className="text-sm text-[color:var(--tx3)]">Loading…</p> : null}
            {!isLoading && secrets.length === 0 ? <p className="text-sm text-[color:var(--tx3)]">No secrets saved yet.</p> : null}
            {secrets.map((secret) => (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-[color:var(--border)] p-3" key={secret.reference}>
                <div className="min-w-0"><p className="font-mono text-sm text-[color:var(--tx)]">{secret.name}</p><p className="text-xs text-[color:var(--tx3)]">{scopeLabel[secret.scopeType]} · {secret.status}</p></div>
                {secret.status === 'active' ? <button className="admin-button admin-button-secondary admin-button-compact" disabled={revokeSecret.isPending} onClick={() => void revokeSecret.mutateAsync(secret.reference)} type="button">Revoke</button> : null}
              </div>
            ))}
          </div>
        </section>
      </div>
    </SettingsPanel>
  )
}
