import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'

import { PairedAgentDetail } from '../../components/features/paired-agents/PairedAgentDetail'
import { credentialLifecycle, credentialTone } from '../../components/features/paired-agents/paired-agent-presentation'
import { FormError } from '../../components/shared/FormActions'
import { QueryState } from '../../components/shared/QueryState'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { Pill } from '../../components/primitives/Pill'
import { OrganizationAdministrationGate } from './OrganizationAdministrationGate'
import {
  useAgentAccessCredentials,
  useOrgAgentAccessCredentials,
  useRevokeAgentAccessCredential,
} from '../../facades/agent-access/hooks'

type PairedAgentDetailPageProps = {
  /**
   * Which list this credential was opened from. The organisation view reads a
   * different route and names whose account the credential borrows; both end
   * at the same screen, because "what can this thing reach, and how do I stop
   * it" is one question wherever it is asked.
   */
  scope: 'organization' | 'user'
}

const PairedAgentDetailBody = ({ scope }: PairedAgentDetailPageProps) => {
  const { t } = useTranslation('settings')
  const navigate = useNavigate()
  const { credentialId } = useParams<{ credentialId?: string }>()
  const organization = scope === 'organization'
  const userCredentials = useAgentAccessCredentials()
  const orgCredentials = useOrgAgentAccessCredentials(organization)
  const credentialsQuery = organization ? orgCredentials : userCredentials
  const revoke = useRevokeAgentAccessCredential()
  const [actionError, setActionError] = useState<string | null>(null)

  const listPath = organization ? '/settings/organization/paired-agents' : '/settings/paired-agents'
  const backToList = () => void navigate(listPath)

  const rows = credentialsQuery.data?.credentials ?? []
  const credential = rows.find((candidate) => candidate.id === credentialId)

  if (!credential) {
    // The header is rendered here too: loading, failure and not-found are
    // states of this screen, and a phone with no header has no Back at all.
    return (
      <SettingsPanel
        backLabel={t('pairedAgents.back')}
        eyebrow={t('pairedAgents.title')}
        onBack={backToList}
        title={t('pairedAgents.agent')}
      >
        <QueryState
          className="py-12"
          emptyLabel={t('pairedAgents.notFound')}
          errorLabel={t('pairedAgents.loadFailed')}
          isEmpty
          loadingLabel={t('pairedAgents.loading')}
          query={credentialsQuery}
        >
          {() => null}
        </QueryState>
      </SettingsPanel>
    )
  }

  const lifecycle = credentialLifecycle(credential)
  const actions: PageHeaderAction[] = lifecycle === 'active'
    ? [{
      id: 'revoke-credential',
      label: revoke.isPending ? t('pairedAgents.revoking') : t('pairedAgents.revoke'),
      onSelect: () => {
        setActionError(null)
        revoke.mutate(credential.id, {
          onError: (error) =>
            setActionError(
              error instanceof Error
                ? error.message
                : t('pairedAgents.revokeFailed'),
            ),
        })
      },
      primary: true,
      priority: 100,
    }]
    : []

  return (
    <SettingsPanel
      actions={actions}
      backLabel={t('pairedAgents.back')}
      eyebrow={t('pairedAgents.title')}
      onBack={backToList}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <Pill height="control" tone={credentialTone(lifecycle)} uppercase={false}>
            {lifecycle}
          </Pill>
          <p className="text-sm text-[color:var(--tx3)]">
            {'user' in credential && credential.user
              ? t('pairedAgents.worksAs', { name: credential.user.displayName })
              : t('pairedAgents.worksAsYou')}
          </p>
        </div>
      }
      title={credential.label}
    >
      <div className="grid gap-3">
        <FormError>{actionError}</FormError>
        <PairedAgentDetail credential={credential} />
      </div>
    </SettingsPanel>
  )
}

export const PairedAgentDetailPage = () => <PairedAgentDetailBody scope="user" />

export const OrganizationPairedAgentDetailPage = () => (
  <OrganizationAdministrationGate>
    <PairedAgentDetailBody scope="organization" />
  </OrganizationAdministrationGate>
)
