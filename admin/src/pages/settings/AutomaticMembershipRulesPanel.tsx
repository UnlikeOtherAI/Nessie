/* eslint-disable max-len -- compact inline content preserves each accessible label with its control. */
import { useState, type FormEvent } from 'react'
import type { AutomaticMembershipRule } from '@nessie/schemas'
import type { MemberRosterScope } from '../../facades/users/member-roster'
import {
  useActivateAutomaticMembershipRule,
  useAutomaticMembershipRules,
  useAutomaticMembershipTeams,
  useCreateAutomaticMembershipRule,
  useRevokeAutomaticMembershipRule,
  useRotateAutomaticMembershipRule,
  useSuspendAutomaticMembershipRule,
  useVerifyAutomaticMembershipRule,
} from '../../facades/users/automatic-membership'
import { Card } from '../../components/shared/Card'
import { Dialog } from '../../components/shared/Dialog'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormActions, FormError } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input } from '../../components/shared/FormControls'
import { QueryState } from '../../components/shared/QueryState'
import { Pill } from '../../components/primitives/Pill'
import { Checkbox } from '../../components/primitives/Checkbox'

type DnsInstruction = { name: string; value: string } | null

const stateTone = (state: string): 'success' | 'warning' | 'danger' | 'default' =>
  state === 'active' || state === 'verified' ? 'success' : state === 'suspended' || state === 'challenge_rotation' ? 'warning' : state === 'revoked' ? 'danger' : 'default'

const formatDate = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not checked yet'

const DnsInstructions = ({ instruction }: { instruction: DnsInstruction }) => instruction ? (
  <div className="space-y-2 border-t border-[color:var(--border)] pt-3 text-sm">
    <p className="font-medium">Add this DNS TXT record, then select Verify DNS.</p>
    <p className="break-all text-[color:var(--tx2)]"><span className="font-medium text-[color:var(--tx)]">Name:</span> {instruction.name}</p>
    <p className="break-all text-[color:var(--tx2)]"><span className="font-medium text-[color:var(--tx)]">Value:</span> {instruction.value}</p>
    <button className="admin-button admin-button-secondary admin-button-compact" onClick={() => void navigator.clipboard?.writeText(instruction.value)} type="button">Copy value</button>
  </div>
) : null

const RuleRow = ({ rule, scope, onInstruction }: { rule: AutomaticMembershipRule; scope: MemberRosterScope; onInstruction: (next: DnsInstruction) => void }) => {
  const verify = useVerifyAutomaticMembershipRule(scope)
  const rotate = useRotateAutomaticMembershipRule(scope)
  const activate = useActivateAutomaticMembershipRule(scope)
  const revoke = useRevokeAutomaticMembershipRule(scope)
  const suspend = useSuspendAutomaticMembershipRule(scope)
  const [error, setError] = useState<string | null>(null)
  const busy = verify.isPending || rotate.isPending || activate.isPending || revoke.isPending || suspend.isPending
  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    try { await action() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to update this automatic login rule.') }
  }
  return (
    <Card as="article" variant="row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{rule.domain}</h3>
          <p className="mt-1 text-sm text-[color:var(--tx2)]">Automatic team access after sign-in. A domain never authenticates a person.</p>
        </div>
        <div className="flex gap-2"><Pill radius="chip" size="sm" tone={stateTone(rule.claimState)} uppercase={false}>{rule.claimState.replace(/_/g, ' ')}</Pill><Pill radius="chip" size="sm" tone={stateTone(rule.state)} uppercase={false}>{rule.state}</Pill></div>
      </div>
      <dl className="mt-3 grid gap-1 text-sm text-[color:var(--tx2)] sm:grid-cols-2">
        <div><dt className="inline font-medium text-[color:var(--tx)]">Last DNS check: </dt><dd className="inline">{formatDate(rule.lastDnsCheckAt)}</dd></div>
        <div><dt className="inline font-medium text-[color:var(--tx)]">Verification expires: </dt><dd className="inline">{formatDate(rule.verificationExpiresAt)}</dd></div>
        {rule.suspensionReason ? <div className="sm:col-span-2"><dt className="inline font-medium text-[color:var(--tx)]">Provisioning paused: </dt><dd className="inline">{rule.suspensionReason}</dd></div> : null}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="admin-button admin-button-secondary admin-button-compact" disabled={busy || rule.state === 'revoked'} onClick={() => void run(async () => { await verify.mutateAsync({ ruleId: rule.id }) })} type="button">Verify DNS</button>
        <button className="admin-button admin-button-secondary admin-button-compact" disabled={busy || rule.state === 'revoked'} onClick={() => void run(async () => { const result = await rotate.mutateAsync({ ruleId: rule.id }) as { dns?: DnsInstruction }; onInstruction(result.dns ?? null) })} type="button">Rotate challenge</button>
        <button className="admin-button admin-button-primary admin-button-compact" disabled={busy || rule.state === 'active' || rule.state === 'revoked'} onClick={() => void run(async () => { await activate.mutateAsync({ ruleId: rule.id }) })} type="button">Activate and backfill</button>
        <button className="admin-button admin-button-secondary admin-button-compact" disabled={busy || rule.state !== 'active'} onClick={() => void run(async () => { await suspend.mutateAsync({ ruleId: rule.id }) })} type="button">Suspend provisioning</button>
        <button className="admin-button admin-button-danger admin-button-compact" disabled={busy || rule.state === 'revoked'} onClick={() => void run(async () => { await revoke.mutateAsync({ ruleId: rule.id }) })} type="button">Revoke rule</button>
      </div>
      <FormError className="mt-2">{error}</FormError>
    </Card>
  )
}

const CreateRuleDialog = ({ scope, onClose, open, onInstruction }: { scope: MemberRosterScope; open: boolean; onClose: () => void; onInstruction: (next: DnsInstruction) => void }) => {
  const create = useCreateAutomaticMembershipRule(scope)
  const teams = useAutomaticMembershipTeams(open && scope === 'organization')
  const [domain, setDomain] = useState('')
  const [notificationEmail, setNotificationEmail] = useState('')
  const [selectedTeams, setSelectedTeams] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null)
    try {
      const result = await create.mutateAsync({ domain, ...(notificationEmail ? { notificationEmail } : {}), ...(scope === 'organization' ? { targetTeamIds: selectedTeams } : {}) }) as { dns?: DnsInstruction }
      onInstruction(result.dns ?? null); onClose(); setDomain(''); setNotificationEmail(''); setSelectedTeams([])
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to create automatic login rule.') }
  }
  return <Dialog description="DNS ownership proof is required before automatic provisioning can begin." onClose={onClose} open={open} title="Add automatic login rule">
    <form className="space-y-4 p-4" onSubmit={(event) => void submit(event)}>
      <FormField label="Email domain"><Input autoComplete="off" onChange={(event) => setDomain(event.target.value)} placeholder="example.com" value={domain} /></FormField>
      <p className="text-xs text-[color:var(--tx3)]">Exact domains only. Email confirmation alone is not domain ownership proof.</p>
      <FormField label="Notification email (optional)"><Input onChange={(event) => setNotificationEmail(event.target.value)} type="email" value={notificationEmail} /></FormField>
      {scope === 'organization' ? <fieldset><legend className="text-sm font-medium">Teams to grant after sign-in</legend><div className="mt-2 grid gap-2">{teams.data?.teams.map((team) => <Checkbox checked={selectedTeams.includes(team.id)} key={team.id} label={team.name} onChange={() => setSelectedTeams((current) => current.includes(team.id) ? current.filter((id) => id !== team.id) : [...current, team.id])} />)}</div></fieldset> : <p className="text-sm text-[color:var(--tx2)]">Matching verified users receive normal member access to this team only.</p>}
      <FormError>{error}</FormError>
      <FormActions><button className="admin-button admin-button-primary" disabled={create.isPending || !domain.trim() || (scope === 'organization' && selectedTeams.length === 0)} type="submit">Create DNS challenge</button></FormActions>
    </form>
  </Dialog>
}

/** One parameterised panel, rendered in both organisation and team member tabs. */
export const AutomaticMembershipRulesPanel = ({ scope }: { scope: MemberRosterScope }) => {
  const rules = useAutomaticMembershipRules(scope)
  const [open, setOpen] = useState(false)
  const [instruction, setInstruction] = useState<DnsInstruction>(null)
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Automatic logins</h2><p className="mt-1 text-sm text-[color:var(--tx2)]">Automatic team access after sign-in. A verified domain never authenticates a person.</p></div><button className="admin-button admin-button-primary" onClick={() => setOpen(true)} type="button">Add domain</button></div>
    {rules.data?.killSwitchEnabled ? <div className="border border-[color:var(--warning)] p-3 text-sm text-[color:var(--tx)]" role="alert">Emergency stop is enabled. Existing memberships are preserved; future automatic provisioning is paused.</div> : null}
    {!rules.data?.featureEnabled && !rules.isLoading ? <div className="text-sm text-[color:var(--tx2)]">This deployment has automatic provisioning disabled. You may prepare DNS ownership proof, but rules cannot activate.</div> : null}
    <DnsInstructions instruction={instruction} />
    <QueryState errorLabel="Automatic login rules could not be loaded." loadingLabel="Loading automatic login rules…" query={rules}>{() => rules.data?.rules.length ? <div className="grid gap-3">{rules.data.rules.map((rule) => <RuleRow key={rule.id} onInstruction={setInstruction} rule={rule} scope={scope} />)}</div> : <EmptyState title="No automatic login rules">Add and verify a company email domain to configure normal member access after sign-in.</EmptyState>}</QueryState>
    <CreateRuleDialog onClose={() => setOpen(false)} onInstruction={setInstruction} open={open} scope={scope} />
  </div>
}
