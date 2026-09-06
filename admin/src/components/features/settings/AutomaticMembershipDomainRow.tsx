/**
 * One claimed domain, with its state, its DNS panel, its teams and its run.
 *
 * Status is carried by the chip's text, never by its colour alone.
 */

import type {
  AutomaticMembershipDomainRecord,
  AutomaticMembershipDomainStatus,
  AutomaticMembershipTeamOption,
} from '@nessie/schemas'

import { Notice } from '../../primitives/Notice'
import { Pill, type PillTone } from '../../primitives/Pill'
import { Switch } from '../../primitives/Switch'
import { AutomaticMembershipDnsPanel } from './AutomaticMembershipDnsPanel'
import { AutomaticMembershipReconcileStatus } from './AutomaticMembershipReconcileStatus'
import { AutomaticMembershipTeamPicker } from './AutomaticMembershipTeamPicker'

const STATUS_LABEL: Record<AutomaticMembershipDomainStatus, string> = {
  active: 'On',
  pending: 'Waiting for DNS',
  revoked: 'Released',
  suspended: 'Paused',
  verified: 'Verified — not on yet',
}

const STATUS_TONE: Record<AutomaticMembershipDomainStatus, PillTone> = {
  active: 'success',
  pending: 'warning',
  revoked: 'muted',
  suspended: 'warning',
  verified: 'info',
}

export type DomainRowActions = {
  onVerify: (id: string) => void
  onRotate: (id: string) => void
  onSetStatus: (id: string, status: 'active' | 'suspended') => void
  onRevoke: (domain: AutomaticMembershipDomainRecord) => void
  onSaveTeams: (id: string, teamIds: string[]) => void
  onToggleTeam: (id: string, enabled: boolean) => void
  onReauthorize: (ruleId: string) => void
  onReconcile: (id: string) => void
  onCancelReconcile: (reconciliationId: string) => void
}

type Props = {
  domain: AutomaticMembershipDomainRecord
  scope: 'organization' | 'team'
  teamOptions: AutomaticMembershipTeamOption[]
  canManageDomains: boolean
  canManageRules: boolean
  pending: boolean
  actions: DomainRowActions
}

export const AutomaticMembershipDomainRow = ({
  actions,
  canManageDomains,
  canManageRules,
  domain,
  pending,
  scope,
  teamOptions,
}: Props) => {
  const needsReauthorization = domain.rules.filter(
    (rule) => rule.health === 'needs_reauthorization',
  )
  const attached = domain.rules.length > 0
  const showDns = canManageDomains
    && (domain.status === 'pending' || domain.status === 'suspended')

  return (
    <article className="grid gap-3 rounded-lg border border-[color:var(--border)] p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="truncate font-medium text-[color:var(--tx)]">{domain.domain}</h3>
          <Pill radius="chip" size="sm" tone={STATUS_TONE[domain.status]} uppercase={false}>
            {STATUS_LABEL[domain.status]}
          </Pill>
        </div>
        {canManageDomains && (domain.status === 'active' || domain.status === 'verified'
          || domain.status === 'suspended') ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[color:var(--tx3)]">
                {domain.status === 'active' ? 'Adding people' : 'Not adding people'}
              </span>
              <Switch
                checked={domain.status === 'active'}
                disabled={pending}
                label={`Add people from ${domain.domain} automatically`}
                onChange={(checked) =>
                  actions.onSetStatus(domain.id, checked ? 'active' : 'suspended')}
              />
            </div>
          ) : null}
      </header>

      {domain.status === 'suspended' ? (
        <Notice role="status" size="sm" tone="warning">
          Paused. Nobody is being added, and nobody has been removed — people who already
          have access keep it.
        </Notice>
      ) : null}

      {needsReauthorization.length > 0 ? (
        <Notice role="status" size="sm" tone="warning">
          <div className="grid gap-2">
            <span>
              {`UnlikeOtherAI no longer accepts the administrator who set `
                + `${needsReauthorization.length === 1 ? 'this rule' : 'these rules'} up, so nobody `
                + `new is being added. Nobody has lost access.`}
            </span>
            {needsReauthorization.map((rule) => (
              <button
                className="admin-button admin-button-secondary admin-button-sm justify-self-start"
                disabled={pending || !rule.manageable}
                key={rule.id}
                onClick={() => actions.onReauthorize(rule.id)}
                type="button"
              >
                {`Re-authorize ${rule.teamName}`}
              </button>
            ))}
          </div>
        </Notice>
      ) : null}

      {showDns ? (
        <AutomaticMembershipDnsPanel
          canManage={canManageDomains}
          domain={domain}
          onRotate={() => actions.onRotate(domain.id)}
          onVerify={() => actions.onVerify(domain.id)}
          pending={pending}
        />
      ) : null}

      {scope === 'organization' ? (
        <AutomaticMembershipTeamPicker
          disabled={!canManageRules || pending}
          domainId={domain.id}
          onSave={(teamIds) => actions.onSaveTeams(domain.id, teamIds)}
          options={teamOptions}
          pending={pending}
          rules={domain.rules}
        />
      ) : (
        <div className="grid gap-2">
          <div className="flex items-center gap-3">
            <Switch
              checked={attached}
              disabled={!canManageRules || pending}
              label={`Add people from ${domain.domain} to this team`}
              onChange={(checked) => actions.onToggleTeam(domain.id, checked)}
            />
            <span className="text-sm font-medium text-[color:var(--tx)]">
              Add people from this domain to this team
            </span>
          </div>
          <p className="text-xs text-[color:var(--tx3)]">
            {attached
              ? 'People signing in with this domain are added to this team as members.'
              : 'This team is not included yet.'}
          </p>
        </div>
      )}

      {scope === 'organization' && domain.status === 'active' && attached ? (
        domain.reconciliation ? (
          <AutomaticMembershipReconcileStatus
            canManage={canManageDomains}
            onCancel={() =>
              actions.onCancelReconcile(domain.reconciliation?.id ?? '')}
            onRerun={() => actions.onReconcile(domain.id)}
            pending={pending}
            run={domain.reconciliation}
          />
        ) : (
          <div className="border-t border-[color:var(--border)] pt-3">
            <button
              className="admin-button admin-button-secondary admin-button-sm"
              disabled={pending || !canManageDomains}
              onClick={() => actions.onReconcile(domain.id)}
              type="button"
            >
              Add people who are already here
            </button>
          </div>
        )
      ) : null}

      {canManageDomains ? (
        <footer className="flex justify-end border-t border-[color:var(--border)] pt-3">
          <button
            className="admin-button admin-button-secondary admin-button-sm"
            disabled={pending}
            onClick={() => actions.onRevoke(domain)}
            type="button"
          >
            Remove domain
          </button>
        </footer>
      ) : null}
    </article>
  )
}
