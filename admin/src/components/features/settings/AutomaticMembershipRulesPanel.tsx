/**
 * Automatic team access after sign-in — the Automatic logins tab.
 *
 * One component, both surfaces, parameterised by scope. It renders `Section`s
 * rather than a second `SettingsPanel`, because `MembersRosterPanel` already
 * provides one and the design system's rule is that a bordered box never sits
 * inside a bordered box.
 *
 * The copy is careful about one thing throughout: a domain never authenticates
 * anybody. Sign-in verifies who someone is; the domain only decides where they
 * land afterwards.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutomaticMembershipDomainRecord } from '@nessie/schemas'

import { formErrorMessage } from '../../../facades/forms/form-errors'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { EmptyState } from '../../shared/EmptyState'
import { FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input } from '../../shared/FormControls'
import { Notice } from '../../primitives/Notice'
import { QueryState } from '../../shared/QueryState'
import { Section } from '../../shared/PageBody'
import { Switch } from '../../primitives/Switch'
import {
  useAddAutomaticMembershipDomain,
  useAutomaticMembership,
  useCancelAutomaticMembershipReconciliation,
  useReauthorizeAutomaticMembershipRule,
  useRevokeAutomaticMembershipDomain,
  useRotateAutomaticMembershipChallenge,
  useSetAutomaticMembershipDomainStatus,
  useSetAutomaticMembershipEnabled,
  useSetAutomaticMembershipTeams,
  useSetTeamAutomaticMembership,
  useStartAutomaticMembershipReconciliation,
  useVerifyAutomaticMembershipDomain,
  type AutomaticMembershipScope,
} from '../../../facades/automatic-membership/hooks'
import { AutomaticMembershipDomainRow } from './AutomaticMembershipDomainRow'

export const AutomaticMembershipRulesPanel = ({
  highlightedRuleId,
  scope,
}: {
  highlightedRuleId?: string | null
  scope: AutomaticMembershipScope
}) => {
  const { t } = useTranslation('settings')
  const query = useAutomaticMembership(scope)
  const [domainInput, setDomainInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<AutomaticMembershipDomainRecord | null>(null)
  const [pendingActivate, setPendingActivate] =
    useState<AutomaticMembershipDomainRecord | null>(null)
  const [pendingPause, setPendingPause] = useState(false)

  const addDomain = useAddAutomaticMembershipDomain()
  const verifyDomain = useVerifyAutomaticMembershipDomain()
  const rotateChallenge = useRotateAutomaticMembershipChallenge()
  const setStatus = useSetAutomaticMembershipDomainStatus()
  const revokeDomain = useRevokeAutomaticMembershipDomain()
  const setTeams = useSetAutomaticMembershipTeams()
  const setTeamRule = useSetTeamAutomaticMembership()
  const reauthorize = useReauthorizeAutomaticMembershipRule(scope)
  const startRun = useStartAutomaticMembershipReconciliation()
  const cancelRun = useCancelAutomaticMembershipReconciliation()
  const setEnabled = useSetAutomaticMembershipEnabled()

  const pending = [
    addDomain, verifyDomain, rotateChallenge, setStatus, revokeDomain,
    setTeams, setTeamRule, reauthorize, startRun, cancelRun, setEnabled,
  ].some((mutation) => mutation.isPending)

  const run = <TInput,>(
    mutation: { mutateAsync: (input: TInput) => Promise<unknown> },
    input: TInput,
  ): void => {
    setError(null)
    void mutation.mutateAsync(input).catch((cause: unknown) => setError(formErrorMessage(cause, t('automaticMembership.actionFailed'))))
  }

  const submitDomain = (event: React.FormEvent) => {
    event.preventDefault()
    const domain = domainInput.trim()
    if (domain.length === 0) return
    setError(null)
    void addDomain
      .mutateAsync({ domain })
      .then(() => setDomainInput(''))
      .catch((cause: unknown) => setError(formErrorMessage(cause, t('automaticMembership.actionFailed'))))
  }

  return (
    <div className="grid gap-5">
      <QueryState
        errorLabel={t('automaticMembership.loadFailed')}
        loadingLabel={t('automaticMembership.loading')}
        query={query}
      >
        {() => {
          const data = query.data
          if (!data) return null
          const { permissions } = data

          return (
            <div className="grid gap-5">
              <Section
                description={t('automaticMembership.lede')}
                title={t('automaticMembership.title')}
              >
                {permissions.manageDomains ? (
                  <div className="grid gap-2">
                    {/* The switch carries an aria-label, which a sighted person
                        cannot read — so the state is named beside it too. */}
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={data.provisioningEnabled}
                        disabled={pending}
                        label={t('automaticMembership.addPeopleAutomatically')}
                        onChange={(enabled) => {
                          // Switching it off is the emergency stop, so it asks.
                          if (enabled) run(setEnabled, { enabled })
                          else setPendingPause(true)
                        }}
                      />
                      <span className="text-sm font-medium text-[color:var(--tx)]">
                        {t('automaticMembership.addPeopleAutomatically')}
                      </span>
                    </div>
                    <p className="text-xs text-[color:var(--tx3)]">
                      {data.provisioningEnabled
                        ? t('automaticMembership.turnOffHelp')
                        : t('automaticMembership.pausedOrganization')}
                    </p>
                  </div>
                ) : !data.provisioningEnabled ? (
                  <Notice role="status" size="sm" tone="warning">
                    {t('automaticMembership.pausedByAdmin')}
                  </Notice>
                ) : null}
              </Section>

              {permissions.manageDomains ? (
                <Section
                  description={t('automaticMembership.domainHelp')}
                  title={t('automaticMembership.addDomainTitle')}
                >
                  <form className="grid gap-2 sm:max-w-md" onSubmit={submitDomain}>
                    <FormField label={t('automaticMembership.emailDomain')}>
                      <Input
                        autoComplete="off"
                        disabled={pending}
                        onChange={(event) => setDomainInput(event.target.value)}
                        placeholder="example.com"
                        value={domainInput}
                      />
                    </FormField>
                    <div>
                      <button
                        className="admin-button admin-button-primary admin-button-sm"
                        disabled={pending || domainInput.trim().length === 0}
                        type="submit"
                      >
                        {addDomain.isPending ? t('automaticMembership.adding') : t('automaticMembership.addDomainTitle')}
                      </button>
                    </div>
                  </form>
                </Section>
              ) : null}

              <FormError>{error}</FormError>

              <Section title={t('automaticMembership.domains')}>
                {data.domains.length === 0 ? (
                  <EmptyState title={t('automaticMembership.noDomains')}>
                    {permissions.manageDomains
                      ? t('automaticMembership.noDomainsOwnerHelp')
                      : t('automaticMembership.noDomainsTeamHelp')}
                  </EmptyState>
                ) : (
                  <div className="grid gap-3">
                    {data.domains.map((domain) => (
                      <AutomaticMembershipDomainRow
                        actions={{
                          onCancelReconcile: (reconciliationId) =>
                            run(cancelRun, { reconciliationId }),
                          onReauthorize: (ruleId) => run(reauthorize, { ruleId }),
                          onReconcile: (id) => run(startRun, { id }),
                          onRevoke: setPendingRevoke,
                          onRotate: (id) => run(rotateChallenge, { id }),
                          onSaveTeams: (id, teamIds) => run(setTeams, { id, teamIds }),
                          onSetStatus: (id, status) => {
                            // Activation places people, so it is confirmed and
                            // names what it is about to do. Pausing is not: it
                            // only ever stops future grants.
                            if (status !== 'active') {
                              run(setStatus, { id, status })
                              return
                            }
                            const target = data.domains.find((entry) => entry.id === id)
                            if (target) setPendingActivate(target)
                          },
                          onToggleTeam: (id, enabled) => run(setTeamRule, { enabled, id }),
                          onVerify: (id) => run(verifyDomain, { id }),
                        }}
                        canManageDomains={permissions.manageDomains}
                        canManageRules={permissions.manageRules}
                        domain={domain}
                        highlightedRuleId={highlightedRuleId}
                        key={domain.id}
                        pending={pending}
                        scope={scope}
                        teamOptions={data.teamOptions}
                      />
                    ))}
                  </div>
                )}
              </Section>
            </div>
          )
        }}
      </QueryState>

      <ConfirmDialog
        body={pendingActivate
          ? t('automaticMembership.activateBody', { domain: pendingActivate.domain, teams: pendingActivate.rules.map((rule) => rule.teamName).join(', ') || t('automaticMembership.selectedTeams') })
          : undefined}
        confirmLabel={t('automaticMembership.turnOnAndAdd')}
        onCancel={() => setPendingActivate(null)}
        onConfirm={() => {
          if (pendingActivate) run(setStatus, { id: pendingActivate.id, status: 'active' })
          setPendingActivate(null)
        }}
        open={pendingActivate !== null}
        pending={setStatus.isPending}
        title={t('automaticMembership.startAddingTitle')}
      />

      <ConfirmDialog
        body={t('automaticMembership.pauseBody')}
        confirmLabel={t('automaticMembership.pauseAdding')}
        destructive
        onCancel={() => setPendingPause(false)}
        onConfirm={() => {
          run(setEnabled, { enabled: false })
          setPendingPause(false)
        }}
        open={pendingPause}
        pending={setEnabled.isPending}
        title={t('automaticMembership.pauseTitle')}
      />

      <ConfirmDialog
        body={pendingRevoke
          ? t('automaticMembership.removeBody', { domain: pendingRevoke.domain })
          : undefined}
        confirmLabel={t('automaticMembership.removeDomain')}
        destructive
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) run(revokeDomain, { id: pendingRevoke.id })
          setPendingRevoke(null)
        }}
        open={pendingRevoke !== null}
        pending={revokeDomain.isPending}
        title={t('automaticMembership.removeDomainTitle')}
      />
    </div>
  )
}
