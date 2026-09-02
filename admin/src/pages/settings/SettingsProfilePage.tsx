import { useNavigate } from 'react-router-dom'
import { useAuthProviders } from '../../facades/auth/hooks'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { useStatuses } from '../../facades/statuses/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { AvatarPanel } from './profile/AvatarPanel'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { Notice } from '../../components/primitives/Notice'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { Card } from '../../components/shared/Card'
import { KeyValueList } from '../../components/shared/KeyValueList'
import { SettingsPanel } from './settings-shared'

// Friendly names for the authenticator a user signed in through. Keyed by the
// provider *type* so the brand shows even when the configured label is a login
// call-to-action ("Sign in with SSO") rather than the product name.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  uoa: 'UnlikeOtherAuthenticator',
  oidc: 'OpenID Connect',
  saml: 'SAML',
  'local-bootstrap': 'Local account',
  custom: 'Custom provider',
}

export const SettingsProfilePage = () => {
  const navigate = useNavigate()
  const { me, logout } = useAuthSession()
  const statusesQuery = useStatuses()
  const organizationQuery = useCurrentOrganization()
  const teamsQuery = useTeams()
  const providersQuery = useAuthProviders()
  const statuses = statusesQuery.data ?? []
  const organization = organizationQuery.data
  const teams = teamsQuery.data
  const providers = providersQuery.data
  const activeStatus = statuses.find((status) => status.activeNow)

  // A failed read here must not render as if the account simply had no
  // organization, team, or provider — the person reading this page cannot
  // tell "unset" from "the fetch failed" unless the two are shown differently.
  const hasLoadError =
    statusesQuery.isError
    || organizationQuery.isError
    || teamsQuery.isError
    || providersQuery.isError

  if (!me) {
    return null
  }

  const organizationName = organization?.name ?? me.context.organizationId
  const teamName =
    teams?.find((team) => team.id === me.context.teamId)?.name ?? me.context.teamId
  const providerDescriptor = providers?.find(
    (provider) => provider.providerId === me.auth.providerId,
  )
  const providerName =
    PROVIDER_DISPLAY_NAMES[me.auth.providerType] ??
    providerDescriptor?.label ??
    me.auth.providerId
  const providerUrl = providerDescriptor?.url

  return (
    <SettingsPanel
      eyebrow="Account"
      title="Profile & Session"
      actions={[
        {
          id: 'sign-out',
          label: 'Sign out',
          onSelect: () => void logout().then(() => navigate('/login', { replace: true })),
          priority: 100,
        } satisfies PageHeaderAction,
      ]}
    >
      {hasLoadError && (
        <Notice className="mb-4" role="alert" tone="danger">
          Some account details failed to load.{' '}
          <button
            className="underline"
            onClick={() => {
              void statusesQuery.refetch()
              void organizationQuery.refetch()
              void teamsQuery.refetch()
              void providersQuery.refetch()
            }}
            type="button"
          >
            Retry
          </button>
        </Notice>
      )}

      <div className="mb-4">
        <AvatarPanel />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card variant="section">
          <SectionLabel>Profile</SectionLabel>
          <div className="mt-4 text-2xl font-semibold text-[color:var(--tx)]">
            {me.user.displayName}
            {activeStatus?.emoji && (
              <span className="ml-2" title={activeStatus.label}>
                {activeStatus.emoji}
              </span>
            )}
          </div>
          {activeStatus && (
            <div className="mt-2 text-sm text-[color:var(--tx2)]">
              {activeStatus.label}
            </div>
          )}
          <div className="mt-1 text-sm text-[color:var(--tx2)]">{me.user.email}</div>
          <KeyValueList
            className="mt-4"
            items={[
              { label: 'Organization', value: organizationName },
              { label: 'Team', value: teamName },
              {
                label: 'Provider',
                value: providerUrl ? (
                  <>
                    {providerName}
                    <div className="mt-0.5 text-xs text-[color:var(--tx3)]">{providerUrl}</div>
                  </>
                ) : providerName,
              },
            ]}
            layout="grid"
          />
        </Card>

        <Card variant="section">
          <SectionLabel>Session</SectionLabel>
          <KeyValueList
            className="mt-4"
            items={[
              { label: 'Session ID', mono: true, value: me.session.sessionId },
              { label: 'Issued', value: new Date(me.session.issuedAt).toLocaleString() },
              { label: 'Auto redirect', value: me.auth.autoRedirectToSso ? 'Enabled' : 'Disabled' },
            ]}
          />
        </Card>
      </div>
    </SettingsPanel>
  )
}
