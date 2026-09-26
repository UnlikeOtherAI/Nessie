/**
 * One claimed domain, with its state, its DNS panel, its teams and its run.
 *
 * Status is carried by the chip's text, never by its colour alone.
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
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
  highlightedRuleId?: string | null
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
  highlightedRuleId,
  pending,
  scope,
  teamOptions,
}: Props) => {
  const { t } = useTranslation('settings')
  const highlightedRuleRef = useRef<HTMLDivElement>(null)
  const needsReauthorization = domain.rules.filter(
    (rule) => rule.health === 'needs_reauthorization',
  )
  const attached = domain.rules.length > 0
  const showDns = canManageDomains
    && (domain.status === 'pending' || domain.status === 'suspended')

  useEffect(() => {
    if (!highlightedRuleRef.current) return
    highlightedRuleRef.current.focus({ preventScroll: true })
    highlightedRuleRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlightedRuleId])

  return (
    <article className="grid gap-3 rounded-lg border border-[color:var(--border)] p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="truncate font-medium text-[color:var(--tx)]">{domain.domain}</h3>
          <Pill radius="chip" size="sm" tone={STATUS_TONE[domain.status]} uppercase={false}>
            {t(`automaticMembership.domainStatuses.${domain.status}`)}
          </Pill>
        </div>
        {canManageDomains && (domain.status === 'active' || domain.status === 'verified'
          || domain.status === 'suspended') ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[color:var(--tx3)]">
                {t(domain.status === 'active' ? 'automaticMembership.addingPeople' : 'automaticMembership.notAddingPeople')}
              </span>
              <Switch
                checked={domain.status === 'active'}
                disabled={pending}
                label={t('automaticMembership.addFromDomain', { domain: domain.domain })}
                onChange={(checked) =>
                  actions.onSetStatus(domain.id, checked ? 'active' : 'suspended')}
              />
            </div>
          ) : null}
      </header>

      {domain.status === 'suspended' ? (
        <Notice role="status" size="sm" tone="warning">
          {t('automaticMembership.pausedNotice')}
        </Notice>
      ) : null}

      {needsReauthorization.length > 0 ? (
        <Notice role="status" size="sm" tone="warning">
          <div className="grid gap-2">
            <span>
              {t('automaticMembership.reauthorizationNeeded', { count: needsReauthorization.length })}
            </span>
            {needsReauthorization.map((rule) => (
              <div
                data-alert-target={rule.id === highlightedRuleId ? 'true' : undefined}
                key={rule.id}
                ref={rule.id === highlightedRuleId ? highlightedRuleRef : undefined}
                tabIndex={rule.id === highlightedRuleId ? -1 : undefined}
              >
                <button
                  className="admin-button admin-button-secondary admin-button-sm justify-self-start"
                  disabled={pending || !rule.manageable}
                  onClick={() => actions.onReauthorize(rule.id)}
                  type="button"
                >
                  {t('automaticMembership.reauthorizeTeam', { team: rule.teamName })}
                </button>
              </div>
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
              label={t('automaticMembership.addToTeam', { domain: domain.domain })}
              onChange={(checked) => actions.onToggleTeam(domain.id, checked)}
            />
            <span className="text-sm font-medium text-[color:var(--tx)]">
              {t('automaticMembership.addDomainToTeam')}
            </span>
          </div>
          <p className="text-xs text-[color:var(--tx3)]">
            {attached
              ? t('automaticMembership.domainWillAdd')
              : t('automaticMembership.teamNotIncluded')}
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
              {t('automaticMembership.addExistingPeople')}
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
            {t('automaticMembership.removeDomain')}
          </button>
        </footer>
      ) : null}
    </article>
  )
}
