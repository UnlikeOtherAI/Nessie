import { useNavigate } from 'react-router-dom'
import { useAuthSession } from '../providers/AuthSessionProvider'

export const SettingsPage = () => {
  const navigate = useNavigate()
  const { logout, me } = useAuthSession()

  if (!me) {
    return (
      <div className="grid gap-6">
        <section className="glass-panel rounded-[2rem] p-8">
          <p className="text-sm text-[color:var(--muted)]">Loading settings...</p>
        </section>
      </div>
    )
  }

  return (
    <div className="grid gap-6">
      <section className="glass-panel rounded-[2rem] p-8">
        <p className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">Profile</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">{me.user.displayName}</h1>
        <div className="mt-4 text-sm text-[color:var(--muted)]">{me.user.email}</div>
        <div className="mt-8 grid gap-3 text-sm">
          <div>Organization: {me.context.organizationId}</div>
          <div>Project: {me.context.projectId}</div>
          <div>Team: {me.context.teamId}</div>
          <div>Channel: {me.context.channelId ?? 'None'}</div>
          <div>
            Provider: {me.auth.providerId} ({me.auth.providerType})
          </div>
        </div>
        <button
          className="mt-8 rounded-2xl bg-[color:var(--danger)] px-5 py-3 text-sm font-medium text-white"
          onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
          type="button"
        >
          Sign out
        </button>
      </section>

      <section className="glass-panel rounded-[2rem] p-8">
        <p className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">Session</p>
        <div className="mt-4 grid gap-4 text-sm">
          <div className="rounded-2xl border border-[color:var(--line)] bg-white/70 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Session ID
            </div>
            <div className="mt-1 break-all font-mono text-xs">{me.session.sessionId}</div>
          </div>
          <div className="rounded-2xl border border-[color:var(--line)] bg-white/70 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Issued
            </div>
            <div className="mt-1">{new Date(me.session.issuedAt).toLocaleString()}</div>
          </div>
          <div className="rounded-2xl border border-[color:var(--line)] bg-white/70 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Bootstrap mode
            </div>
            <div className="mt-1">{me.context.bootstrapMode ? 'Enabled' : 'Disabled'}</div>
          </div>
          <div className="rounded-2xl border border-[color:var(--line)] bg-white/70 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Auto redirect
            </div>
            <div className="mt-1">{me.auth.autoRedirectToSso ? 'Enabled' : 'Disabled'}</div>
          </div>
        </div>
      </section>
    </div>
  )
}
