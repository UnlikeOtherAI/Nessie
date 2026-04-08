import { useEffect } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthSession } from '../providers/AuthSessionProvider'

export const SettingsPage = () => {
  const navigate = useNavigate()
  const { logout, me, sessionState } = useAuthSession()

  useEffect(() => {
    if (sessionState === 'unauthenticated') {
      void navigate('/login', { replace: true })
    }
  }, [navigate, sessionState])

  if (sessionState === 'unauthenticated') {
    return <Navigate to="/login" replace />
  }

  if (!me) {
    return (
      <main className="min-h-screen px-6 py-10">
        <div className="mx-auto max-w-3xl glass-panel rounded-[2rem] p-8">
          Loading settings...
        </div>
      </main>
    )
  }

  const handleLogout = () => {
    void logout().then(() => navigate('/login', { replace: true }))
  }

  return (
    <main className="min-h-screen px-6 py-10">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <section className="glass-panel rounded-[2rem] p-8">
          <p className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
            Profile
          </p>
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
            onClick={handleLogout}
            type="button"
          >
            Sign out
          </button>
        </section>

        <section className="glass-panel rounded-[2rem] p-8">
          <p className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
            Session
          </p>
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
    </main>
  )
}
