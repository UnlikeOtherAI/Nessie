import { useState } from 'react'
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
  const navigate = useNavigate()
  const { credentialId } = useParams<{ credentialId?: string }>()
  const organization = scope === 'organization'
  const userCredentials = useAgentAccessCredentials()
  const orgCredentials = useOrgAgentAccessCredentials(organization)
  const credentialsQuery = organization ? orgCredentials : userCredentials
  const revoke = useRevokeAgentAccessCredential()
  const [actionError, setActionError] = useState<string | null>(null)

  const listPath = organization ? '/admin/security?tab=programs' : '/settings/security'
  const eyebrow = organization ? 'Programs signed in as people' : 'Programs signed in as you'
  const backToList = () => void navigate(listPath)

  const rows = credentialsQuery.data?.credentials ?? []
  const credential = rows.find((candidate) => candidate.id === credentialId)

  if (!credential) {
    // The header is rendered here too: loading, failure and not-found are
    // states of this screen, and a phone with no header has no Back at all.
    return (
      <SettingsPanel
        backLabel="Back to Security"
        eyebrow={eyebrow}
        onBack={backToList}
        title="Program"
      >
        <QueryState
          className="py-12"
          emptyLabel="This credential could not be found. It may already have been removed."
          errorLabel="Could not load paired agents."
          isEmpty
          loadingLabel="Loading paired agent…"
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
      label: revoke.isPending ? 'Revoking…' : 'Revoke',
      onSelect: () => {
        setActionError(null)
        revoke.mutate(credential.id, {
          onError: (error) =>
            setActionError(
              error instanceof Error
                ? error.message
                : 'That credential could not be revoked. It is still live.',
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
      backLabel="Back to Security"
      eyebrow={eyebrow}
      onBack={backToList}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <Pill height="control" tone={credentialTone(lifecycle)} uppercase={false}>
            {lifecycle}
          </Pill>
          <p className="text-sm text-[color:var(--tx3)]">
            {'user' in credential && credential.user
              ? `Works as ${credential.user.displayName}`
              : 'Works as you'}
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
