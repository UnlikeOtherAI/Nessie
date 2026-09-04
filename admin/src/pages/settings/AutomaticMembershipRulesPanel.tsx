import { useEffect, useState, type FormEvent } from 'react'
import type { MemberRosterScope } from '../../facades/users/member-roster'
import {
  type AutomaticMembershipRuleView,
  useActivateAutomaticMembershipRule,
  useAutomaticMembershipRules,
  useAutomaticMembershipTeams,
  useCreateAutomaticMembershipRule,
  useReleaseAutomaticMembershipClaim,
  useRevokeAutomaticMembershipRule,
  useRotateAutomaticMembershipRule,
  useSuspendAutomaticMembershipRule,
  useUpdateAutomaticMembershipRule,
  useVerifyAutomaticMembershipRule,
} from '../../facades/users/automatic-membership'
import { Checkbox } from '../../components/primitives/Checkbox'
import { Pill, type PillTone } from '../../components/primitives/Pill'
import { Card } from '../../components/shared/Card'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { Dialog } from '../../components/shared/Dialog'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormActions, FormError } from '../../components/shared/FormActions'
import { Input } from '../../components/shared/FormControls'
import { FormField } from '../../components/shared/FormField'
import { QueryState } from '../../components/shared/QueryState'
import { useToasts } from '../../providers/ToastProvider'

type DnsInstruction = { name: string; value: string } | null
type PendingAction = 'activate' | 'suspend' | 'revoke' | 'release'
type ConfirmingAction = { action: PendingAction; rule: AutomaticMembershipRuleView } | null

const stateTone = (state: string): PillTone => {
  if (state === 'active' || state === 'verified') return 'success'
  if (state === 'suspended' || state === 'challenge_rotation') return 'warning'
  return state === 'revoked' ? 'danger' : 'muted'
}

const dateLabel = (value: string | null | undefined, fallback = 'Not checked yet') => {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? fallback : date.toLocaleString()
}

const DnsInstructions = ({ instruction }: { instruction: DnsInstruction }) => {
  if (!instruction) return null
  return (
    <div className="border-y border-[color:var(--border)] py-3 text-sm" data-testid="automatic-membership-dns-instructions">
      <p className="font-medium">DNS ownership proof</p>
      <p className="mt-1 text-[color:var(--tx2)]">Publish this TXT record, then select Verify DNS. An email confirmation is not proof of domain ownership.</p>
      <dl className="mt-3 grid gap-1 break-all text-[color:var(--tx2)]">
        <div><dt className="inline font-medium text-[color:var(--tx)]">Name: </dt><dd className="inline">{instruction.name}</dd></div>
        <div><dt className="inline font-medium text-[color:var(--tx)]">Value: </dt><dd className="inline">{instruction.value}</dd></div>
      </dl>
      <button className="admin-button admin-button-secondary admin-button-compact mt-3" onClick={() => void navigator.clipboard?.writeText(instruction.value)} type="button">Copy value</button>
    </div>
  )
}

const TeamMapping = ({
  teams,
  selected,
  setSelected,
}: {
  teams: ReturnType<typeof useAutomaticMembershipTeams>
  selected: string[]
  setSelected: (next: string[]) => void
}) => {
  if (teams.isLoading) return <p className="text-sm text-[color:var(--tx3)]">Loading teams available to this organization…</p>
  if (teams.isError) return <div className="text-sm text-[color:var(--danger-text)]">Teams could not be loaded. <button className="underline" onClick={() => void teams.refetch()} type="button">Retry</button></div>
  if (!teams.data?.teams.length) return <p className="text-sm text-[color:var(--danger-text)]">There are no eligible teams. Create a team first, then return to map this domain.</p>
  return (
    <fieldset>
      <legend className="text-sm font-medium">Teams to grant after sign-in</legend>
      <p className="mt-1 text-sm text-[color:var(--tx2)]">Matching verified users receive only normal member access to the checked teams.</p>
      <div className="mt-3 grid gap-2">
        {teams.data.teams.map((team) => (
          <Checkbox
            checked={selected.includes(team.id)}
            key={team.id}
            label={team.name}
            onChange={() => setSelected(selected.includes(team.id)
              ? selected.filter((id) => id !== team.id)
              : [...selected, team.id])}
          />
        ))}
      </div>
    </fieldset>
  )
}

const RuleEditorDialog = ({
  initialRule,
  onClose,
  onInstruction,
  open,
  scope,
}: {
  initialRule: AutomaticMembershipRuleView | null
  onClose: () => void
  onInstruction: (next: DnsInstruction) => void
  open: boolean
  scope: MemberRosterScope
}) => {
  const create = useCreateAutomaticMembershipRule(scope)
  const update = useUpdateAutomaticMembershipRule(scope)
  const teams = useAutomaticMembershipTeams(open && scope === 'organization')
  const [domain, setDomain] = useState('')
  const [notificationEmail, setNotificationEmail] = useState('')
  const [selectedTeams, setSelectedTeams] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const isEdit = initialRule !== null
  const effectiveTeams = selectedTeams
  const effectiveEmail = notificationEmail

  useEffect(() => {
    if (!open) return
    setDomain('')
    setNotificationEmail(initialRule?.notificationEmail ?? '')
    setSelectedTeams(initialRule?.targetTeamIds ?? [])
    setError(null)
  }, [initialRule, open])

  const close = () => {
    setDomain('')
    setNotificationEmail('')
    setSelectedTeams([])
    setError(null)
    onClose()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      if (initialRule) {
        await update.mutateAsync({
          ruleId: initialRule.id,
          notificationEmail: effectiveEmail.trim() || null,
          ...(scope === 'organization' ? { targetTeamIds: effectiveTeams } : {}),
        })
      } else {
        const result = await create.mutateAsync({
          domain,
          ...(effectiveEmail.trim() ? { notificationEmail: effectiveEmail.trim() } : {}),
          ...(scope === 'organization' ? { targetTeamIds: effectiveTeams } : {}),
        }) as { dns?: DnsInstruction }
        onInstruction(result.dns ?? null)
      }
      close()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save this automatic login rule.')
    }
  }

  return (
    <Dialog description="DNS ownership proof is required before automatic provisioning can begin." onClose={close} open={open} title={isEdit ? 'Edit automatic login rule' : 'Add automatic login rule'}>
      <form className="space-y-4 p-4" onSubmit={(event) => void submit(event)}>
        {initialRule ? <FormField label="Email domain"><Input disabled value={initialRule.domain} /></FormField> : <FormField label="Email domain"><Input autoComplete="off" onChange={(event) => setDomain(event.target.value)} placeholder="example.com" value={domain} /></FormField>}
        <p className="text-xs text-[color:var(--tx3)]">Exact domains only. A domain never authenticates a person; UOA must assert a currently verified email at sign-in.</p>
        <FormField label="Notification email (optional)"><Input onChange={(event) => setNotificationEmail(event.target.value)} type="email" value={effectiveEmail} /></FormField>
        {scope === 'organization' ? <TeamMapping selected={effectiveTeams} setSelected={setSelectedTeams} teams={teams} /> : <p className="text-sm text-[color:var(--tx2)]">Matching verified users receive normal member access to this team only.</p>}
        <FormError>{error}</FormError>
        <FormActions><button className="admin-button admin-button-primary" disabled={create.isPending || update.isPending || (!isEdit && !domain.trim()) || (scope === 'organization' && (!effectiveTeams.length || teams.isLoading || teams.isError || !teams.data?.teams.length))} type="submit">{isEdit ? 'Save rule' : 'Create DNS challenge'}</button></FormActions>
      </form>
    </Dialog>
  )
}

const BackfillSummary = ({ rule }: { rule: AutomaticMembershipRuleView }) => {
  const backfill = rule.backfill
  if (!backfill) return null
  return (
    <div className="mt-3 border-t border-[color:var(--border)] pt-3 text-sm text-[color:var(--tx2)]">
      <p className="font-medium text-[color:var(--tx)]">Reconciliation</p>
      <p className="mt-1">{backfill.status.replace(/_/g, ' ')} · {backfill.processedCount} processed · {backfill.grantedCount} granted · {backfill.failedCount} failed</p>
      {backfill.nextRetryAt ? <p>Next retry: {dateLabel(backfill.nextRetryAt)}</p> : null}
      <p className="mt-1 text-xs text-[color:var(--tx3)]">Progress is aggregate only. Matching people stay in UOA and are not listed here.</p>
    </div>
  )
}

const AuditHistory = ({ rule }: { rule: AutomaticMembershipRuleView }) => {
  if (!rule.auditEvents?.length) return null
  return (
    <div className="mt-3 border-t border-[color:var(--border)] pt-3 text-sm">
      <p className="font-medium">Recent audit history</p>
      <ul className="mt-2 space-y-1 text-[color:var(--tx2)]">
        {rule.auditEvents.slice(0, 5).map((event) => <li key={event.id}>{dateLabel(event.createdAt, 'Unknown time')} · {event.action.replace(/_/g, ' ')}{event.detail ? ` · ${event.detail}` : ''}</li>)}
      </ul>
    </div>
  )
}

const RuleRow = ({
  canManage,
  canManageClaim,
  onConfirm,
  onEdit,
  onInstruction,
  rule,
  scope,
}: {
  canManage: boolean
  canManageClaim: boolean
  onConfirm: (next: ConfirmingAction) => void
  onEdit: (rule: AutomaticMembershipRuleView) => void
  onInstruction: (next: DnsInstruction) => void
  rule: AutomaticMembershipRuleView
  scope: MemberRosterScope
}) => {
  const verify = useVerifyAutomaticMembershipRule(scope)
  const rotate = useRotateAutomaticMembershipRule(scope)
  const { pushToast } = useToasts()
  const [error, setError] = useState<string | null>(null)
  const busy = verify.isPending || rotate.isPending
  const run = async (label: string, action: () => Promise<unknown>) => {
    setError(null)
    try {
      const result = await action() as { dns?: DnsInstruction }
      if (result.dns) onInstruction(result.dns)
      pushToast({ body: `${rule.domain} was updated.`, title: label })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Unable to update this automatic login rule.'
      setError(message)
      pushToast({ body: message, title: 'Automatic login rule was not updated' })
    }
  }
  return (
    <Card as="article" variant="row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="font-semibold">{rule.domain}</h3><p className="mt-1 text-sm text-[color:var(--tx2)]">Automatic team access after sign-in. A domain never authenticates a person.</p></div>
        <div className="flex gap-2"><Pill radius="chip" size="sm" tone={stateTone(rule.claimState)} uppercase={false}>{rule.claimState.replace(/_/g, ' ')}</Pill><Pill radius="chip" size="sm" tone={stateTone(rule.state)} uppercase={false}>{rule.state}</Pill></div>
      </div>
      <dl className="mt-3 grid gap-1 text-sm text-[color:var(--tx2)] sm:grid-cols-2">
        <div><dt className="inline font-medium text-[color:var(--tx)]">Last DNS check: </dt><dd className="inline">{dateLabel(rule.lastDnsCheckAt)}</dd></div>
        <div><dt className="inline font-medium text-[color:var(--tx)]">Verification expires: </dt><dd className="inline">{dateLabel(rule.verificationExpiresAt, 'Not verified')}</dd></div>
        {rule.suspensionReason ? <div className="sm:col-span-2"><dt className="inline font-medium text-[color:var(--tx)]">Provisioning paused: </dt><dd className="inline">{rule.suspensionReason}</dd></div> : null}
      </dl>
      <DnsInstructions instruction={rule.dns ?? null} />
      {scope === 'organization' && rule.targetTeams?.length ? <p className="mt-3 text-sm text-[color:var(--tx2)]"><span className="font-medium text-[color:var(--tx)]">Mapped teams: </span>{rule.targetTeams.map((team) => team.name).join(', ')}</p> : null}
      <BackfillSummary rule={rule} />
      <AuditHistory rule={rule} />
      {canManage ? <div className="mt-3 flex flex-wrap gap-2">
        <button className="admin-button admin-button-secondary admin-button-compact" disabled={busy || rule.state === 'revoked'} onClick={() => onEdit(rule)} type="button">Edit mapping</button>
        {canManageClaim ? <button className="admin-button admin-button-secondary admin-button-compact" disabled={busy || rule.state === 'revoked'} onClick={() => void run('DNS verification requested', () => verify.mutateAsync({ ruleId: rule.id }))} type="button">Verify DNS</button> : null}
        {canManageClaim ? <button className="admin-button admin-button-secondary admin-button-compact" disabled={busy || rule.state === 'revoked'} onClick={() => void run('DNS challenge rotated', () => rotate.mutateAsync({ ruleId: rule.id }))} type="button">Rotate challenge</button> : null}
        <button className="admin-button admin-button-primary admin-button-compact" disabled={rule.state === 'active' || rule.state === 'revoked' || rule.claimState !== 'verified'} onClick={() => onConfirm({ action: 'activate', rule })} type="button">Activate and backfill</button>
        <button className="admin-button admin-button-secondary admin-button-compact" disabled={rule.state !== 'active'} onClick={() => onConfirm({ action: 'suspend', rule })} type="button">Suspend provisioning</button>
        <button className="admin-button admin-button-danger admin-button-compact" disabled={rule.state === 'revoked'} onClick={() => onConfirm({ action: 'revoke', rule })} type="button">Revoke rule</button>
        {canManageClaim && rule.state === 'revoked' ? <button className="admin-button admin-button-danger admin-button-compact" onClick={() => onConfirm({ action: 'release', rule })} type="button">Release domain</button> : null}
      </div> : null}
      <FormError className="mt-2">{error}</FormError>
    </Card>
  )
}

const confirmCopy: Record<PendingAction, { body: string; confirmLabel: string; title: string }> = {
  activate: { title: 'Activate and start reconciliation?', confirmLabel: 'Activate and backfill', body: 'Matching verified UOA identities will receive only normal member access to this rule’s selected teams. Existing memberships and stronger roles are preserved.' },
  suspend: { title: 'Suspend automatic provisioning?', confirmLabel: 'Suspend provisioning', body: 'This stops future automatic grants. Existing memberships are preserved.' },
  revoke: { title: 'Revoke this automatic login rule?', confirmLabel: 'Revoke rule', body: 'This permanently stops future grants for this rule. Existing memberships are preserved; member removal remains explicit.' },
  release: { title: 'Release this domain claim?', confirmLabel: 'Release domain', body: 'Another organization may verify and claim this domain after release. Existing memberships and audit evidence are preserved.' },
}

/** One parameterised panel, rendered in both organization and team Members tabs. */
export const AutomaticMembershipRulesPanel = ({ scope }: { scope: MemberRosterScope }) => {
  const rules = useAutomaticMembershipRules(scope)
  const activate = useActivateAutomaticMembershipRule(scope)
  const suspend = useSuspendAutomaticMembershipRule(scope)
  const revoke = useRevokeAutomaticMembershipRule(scope)
  const release = useReleaseAutomaticMembershipClaim(scope)
  const { pushToast } = useToasts()
  const [editorRule, setEditorRule] = useState<AutomaticMembershipRuleView | null | 'new'>(null)
  const [confirming, setConfirming] = useState<ConfirmingAction>(null)
  const [instruction, setInstruction] = useState<DnsInstruction>(null)
  const canManage = rules.data?.permissions?.manageRules === true
  const canManageClaim = rules.data?.permissions?.manageClaim === true
  const actionPending = activate.isPending || suspend.isPending || revoke.isPending || release.isPending
  const applyConfirmedAction = async () => {
    if (!confirming) return
    const { action, rule } = confirming
    try {
      if (action === 'activate') await activate.mutateAsync({ ruleId: rule.id })
      if (action === 'suspend') await suspend.mutateAsync({ ruleId: rule.id })
      if (action === 'revoke') await revoke.mutateAsync({ ruleId: rule.id })
      if (action === 'release') await release.mutateAsync({ ruleId: rule.id })
      pushToast({ body: `${rule.domain} was updated. Existing memberships were not removed.`, title: confirmCopy[action].confirmLabel })
      setConfirming(null)
    } catch (caught) {
      pushToast({ body: caught instanceof Error ? caught.message : 'The rule could not be updated.', title: 'Automatic login rule was not updated' })
    }
  }
  const copy = confirming ? confirmCopy[confirming.action] : null
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Automatic logins</h2><p className="mt-1 text-sm text-[color:var(--tx2)]">Automatic team access after sign-in. A verified domain never authenticates a person.</p></div>{canManage ? <button className="admin-button admin-button-primary" onClick={() => setEditorRule('new')} type="button">Add domain</button> : null}</div>
      <QueryState errorLabel="Automatic login rules could not be loaded." loadingLabel="Loading automatic login rules…" query={rules}>{() => <>
        {rules.data?.killSwitchEnabled ? <div className="border-y border-[color:var(--warning)] py-3 text-sm" role="alert">Emergency stop is enabled. Existing memberships are preserved; future automatic provisioning is paused.</div> : null}
        {!rules.data?.featureEnabled ? <div className="border-y border-[color:var(--border)] py-3 text-sm text-[color:var(--tx2)]">Automatic provisioning is disabled for this deployment. Rules cannot activate until an administrator enables the feature.</div> : null}
        {!canManage ? <div className="border-y border-[color:var(--border)] py-3 text-sm text-[color:var(--tx2)]" role="status">Only an authorized {scope === 'organization' ? 'organization' : 'team'} owner or administrator can manage automatic login rules.</div> : null}
        <DnsInstructions instruction={instruction} />
        {rules.data?.rules.length ? <div className="grid gap-3">{rules.data.rules.map((rule) => <RuleRow canManage={canManage} canManageClaim={canManageClaim} key={rule.id} onConfirm={setConfirming} onEdit={setEditorRule} onInstruction={setInstruction} rule={rule} scope={scope} />)}</div> : <EmptyState title="No automatic login rules">{canManage ? 'Add and verify a company email domain to configure normal member access after sign-in.' : 'There are no automatic login rules to view.'}</EmptyState>}
      </>}</QueryState>
      <RuleEditorDialog initialRule={editorRule === 'new' ? null : editorRule} onClose={() => setEditorRule(null)} onInstruction={setInstruction} open={editorRule !== null} scope={scope} />
      {copy ? <ConfirmDialog body={copy.body} confirmLabel={copy.confirmLabel} destructive={confirming?.action !== 'activate'} onCancel={() => setConfirming(null)} onConfirm={() => void applyConfirmedAction()} open title={copy.title} pending={actionPending} /> : null}
    </div>
  )
}
