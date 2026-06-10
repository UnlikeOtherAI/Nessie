import { useNavigate } from 'react-router-dom'
import { useStatuses } from '../../facades/statuses/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { sectionTitleClass, SettingsPanel } from './settings-shared'

export const SettingsProfilePage = () => {
  const navigate = useNavigate()
  const { me, logout } = useAuthSession()
  const { data: statuses = [] } = useStatuses()
  const activeStatus = statuses.find((status) => status.activeNow)

  if (!me) {
    return null
  }

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
          <div className="mt-4 grid gap-2 text-sm text-[color:var(--tx2)]">
            <div>Organization: {me.context.organizationId}</div>
            <div>Project: {me.context.projectId}</div>
            <div>Team: {me.context.teamId}</div>
            <div>
              Provider: {me.auth.providerId} ({me.auth.providerType})
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
