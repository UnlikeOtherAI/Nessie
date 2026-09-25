import { useState } from 'react'
import type { ExecutorPairingOptions, ExecutorPairingPreview, ExecutorScope } from '@nessie/schemas'
import { ExecutorScopeSchema } from '@nessie/schemas'
import type { ProjectRecord } from '../../../lib/api-client'
import { FormActions, FormError } from '../../shared/FormActions'

type Props = {
  busy: boolean
  error: string | null
  initialAudience?: 'personal' | 'team'
  fixedProjectId?: string
  onBack: () => void
  onClaim: (input: { label: string; scope: ExecutorScope; teamId: string | null }) => void
  options: ExecutorPairingOptions
  preview: ExecutorPairingPreview
  projects: ProjectRecord[]
  remaining: number
}
const platformLabels = { linux: 'Linux', macos: 'Mac', windows: 'Windows' } as const

export const ExecutorPairingReview = ({ busy, error, onBack, onClaim, options, preview, remaining }: Props) => {
  const [label, setLabel] = useState(preview.machineName)
  const [confirmed, setConfirmed] = useState(false)
  const team = options.teams.length === 1 ? options.teams[0] : null
  return <form className="grid gap-4" onSubmit={(event) => {
    event.preventDefault()
    if (!confirmed || !team || !label.trim() || busy) return
    onClaim({ label: label.trim(), teamId: team.id,
      scope: ExecutorScopeSchema.parse({ kind: 'private', organizationId: options.organization.id }) })
  }}>
    <div className="grid gap-1 text-sm text-[color:var(--tx2)]">
      <p><strong className="text-[color:var(--tx)]">{preview.machineName}</strong> · {platformLabels[preview.platformFacts.platform.os]}</p>
      <p>{options.organization.name} · {team?.name}</p>
      <p className="text-xs text-[color:var(--tx3)]">Code expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</p>
    </div>
    <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">Machine name
      <input className="admin-input" maxLength={120} onChange={(event) => setLabel(event.target.value)} required value={label} />
    </label>
    <p className="text-sm text-[color:var(--tx2)]">This executor starts with you. Add agents and share it with people, projects, or everyone in this team after pairing.</p>
    <label className="grid gap-2 border-t border-[color:var(--sep)] pt-3 text-xs text-[color:var(--tx2)]">
      <span className="break-all font-mono text-[color:var(--tx3)]">{preview.fingerprint}</span>
      <span className="flex items-start gap-2">
        <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
        <span>The fingerprint matches the one shown on my machine.</span>
      </span>
    </label>
    <FormError>{error ?? (!team ? 'Select a team in Nessie before pairing this executor.' : null)}</FormError>
    <FormActions>
      <button className="admin-button admin-button-secondary" disabled={busy} onClick={onBack} type="button">Back</button>
      <button className="admin-button admin-button-primary" disabled={busy || !confirmed || !team || !label.trim()} type="submit">
        {busy ? 'Pairing…' : 'Pair machine'}
      </button>
    </FormActions>
  </form>
}
