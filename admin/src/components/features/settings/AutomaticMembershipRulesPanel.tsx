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
import type { AutomaticMembershipDomainRecord } from '@nessie/schemas'

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

const LEDE = 'When someone signs in with an email address at a domain you control, add them '
  + 'to these teams as a member. Sign-in always verifies who someone is — a domain never '
  + 'signs anyone in.'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong. Try again.'

export const AutomaticMembershipRulesPanel = ({
  scope,
}: {
  scope: AutomaticMembershipScope
}) => {
  const query = useAutomaticMembership(scope)
  const [domainInput, setDomainInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<AutomaticMembershipDomainRecord | null>(null)

  const addDomain = useAddAutomaticMembershipDomain()
  const verifyDomain = useVerifyAutomaticMembershipDomain()
  const rotateChallenge = useRotateAutomaticMembershipChallenge()
  const setStatus = useSetAutomaticMembershipDomainStatus()
  const revokeDomain = useRevokeAutomaticMembershipDomain()
  const setTeams = useSetAutomaticMembershipTeams()
  const setTeamRule = useSetTeamAutomaticMembership()
  const reauthorize = useReauthorizeAutomaticMembershipRule()
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
    void mutation.mutateAsync(input).catch((cause: unknown) => setError(errorMessage(cause)))
  }

  const submitDomain = (event: React.FormEvent) => {
    event.preventDefault()
    const domain = domainInput.trim()
    if (domain.length === 0) return
    setError(null)
    void addDomain
      .mutateAsync({ domain })
      .then(() => setDomainInput(''))
      .catch((cause: unknown) => setError(errorMessage(cause)))
  }

  return (
    <div className="grid gap-5">
      <QueryState
        errorLabel="Automatic access settings could not be loaded."
        loadingLabel="Loading automatic access…"
        query={query}
      >
        {() => {
          const data = query.data
          if (!data) return null
          const { permissions } = data

          return (
            <div className="grid gap-5">
              <Section
                description={LEDE}
                title="Automatic team access after sign-in"
              >
                {permissions.manageDomains ? (
                  <div className="grid gap-2">
                    <Switch
                      checked={data.provisioningEnabled}
                      disabled={pending}
                      label="Add people automatically"
                      onChange={(enabled) => run(setEnabled, { enabled })}
                    />
                    <p className="text-xs text-[color:var(--tx3)]">
                      {data.provisioningEnabled
                        ? 'Turning this off stops new people being added. Nobody is removed.'
                        : 'Paused for the whole organisation. Nobody is being added, and '
                          + 'nobody has been removed.'}
                    </p>
                  </div>
                ) : !data.provisioningEnabled ? (
                  <Notice role="status" size="sm" tone="warning">
                    An organisation administrator has paused automatic access.
                  </Notice>
                ) : null}
              </Section>

              {permissions.manageDomains ? (
                <Section
                  description="Only a domain your organisation controls. Personal email
                    providers cannot be used, and each subdomain is verified separately."
                  title="Add a domain"
                >
                  <form className="grid gap-2 sm:max-w-md" onSubmit={submitDomain}>
                    <FormField label="Email domain">
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
                        {addDomain.isPending ? 'Adding…' : 'Add domain'}
                      </button>
                    </div>
                  </form>
                </Section>
              ) : null}

              <FormError>{error}</FormError>

              <Section title="Domains">
                {data.domains.length === 0 ? (
                  <EmptyState title="No domains yet">
                    {permissions.manageDomains
                      ? 'Add a domain your organisation controls to place people into teams '
                        + 'automatically when they sign in.'
                      : 'No domain adds people to this team automatically. An organisation '
                        + 'administrator can set one up.'}
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
                          onSetStatus: (id, status) => run(setStatus, { id, status }),
                          onToggleTeam: (id, enabled) => run(setTeamRule, { enabled, id }),
                          onVerify: (id) => run(verifyDomain, { id }),
                        }}
                        canManageDomains={permissions.manageDomains}
                        canManageRules={permissions.manageRules}
                        domain={domain}
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
        body={pendingRevoke
          ? `People already in these teams keep their access — removing ${pendingRevoke.domain} `
            + 'only stops new people being added. You can add the domain again later.'
          : undefined}
        confirmLabel="Remove domain"
        destructive
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) run(revokeDomain, { id: pendingRevoke.id })
          setPendingRevoke(null)
        }}
        open={pendingRevoke !== null}
        pending={revokeDomain.isPending}
        title="Remove this domain?"
      />
    </div>
  )
}
