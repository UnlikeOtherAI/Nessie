import { useNavigate } from 'react-router-dom'
import { useAuthProviders } from '../../facades/auth/hooks'
import { useCurrentOrganization } from '../../facades/organization/hooks'
import { useTeams } from '../../facades/projects/hooks'
import { useStatuses } from '../../facades/statuses/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { AvatarPanel } from './profile/AvatarPanel'
import { sectionTitleClass, SettingsPanel } from './settings-shared'

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

const fieldLabelClass =
  'text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]'

export const SettingsProfilePage = () => {
  const navigate = useNavigate()
  const { me, logout } = useAuthSession()
  const { data: statuses = [] } = useStatuses()
  const { data: organization } = useCurrentOrganization()
  const { data: teams } = useTeams()
  const { data: providers } = useAuthProviders()
  const activeStatus = statuses.find((status) => status.activeNow)

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
      eyebrow="General"
      title="Profile & Session"
      actions={
        <button
          className="admin-button admin-button-secondary"
          onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
          type="button"
        >
          Sign out
        </button>
      }
    >
      <div className="mb-4">
        <AvatarPanel />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="admin-card p-4">
          <div className={sectionTitleClass}>Profile</div>
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
          <div className="mt-4 grid gap-3 text-sm text-[color:var(--tx2)]">
            <div>
              <div className={fieldLabelClass}>Organization</div>
              <div className="mt-0.5 text-[color:var(--tx)]">{organizationName}</div>
            </div>
            <div>
              <div className={fieldLabelClass}>Team</div>
              <div className="mt-0.5 text-[color:var(--tx)]">{teamName}</div>
            </div>
            <div>
              <div className={fieldLabelClass}>Provider</div>
              <div className="mt-0.5 text-[color:var(--tx)]">{providerName}</div>
              {providerUrl && (
                <div className="text-xs text-[color:var(--tx3)]">{providerUrl}</div>
              )}
            </div>
          </div>
        </section>

        <section className="admin-card p-4">
          <div className={sectionTitleClass}>Session</div>
          <div className="mt-4 grid gap-3 text-sm text-[color:var(--tx2)]">
            <div className="admin-card p-3">
              <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                Session ID
              </div>
              <div className="mt-1 break-all font-mono text-xs text-[color:var(--tx)]">
                {me.session.sessionId}
              </div>
            </div>
            <div className="admin-card p-3">
              <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                Issued
              </div>
              <div className="mt-1">{new Date(me.session.issuedAt).toLocaleString()}</div>
            </div>
            <div className="admin-card p-3">
              <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                Auto redirect
              </div>
              <div className="mt-1">
                {me.auth.autoRedirectToSso ? 'Enabled' : 'Disabled'}
              </div>
            </div>
          </div>
        </section>
      </div>
    </SettingsPanel>
  )
}
