import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthProviders } from '../facades/auth/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

const fieldClass = [
  'w-full rounded-2xl border border-[color:var(--line)]',
  'bg-white/80 px-4 py-3 text-sm text-[color:var(--ink)]',
  'outline-none transition focus:border-[color:var(--accent)]',
  'focus:ring-2 focus:ring-[color:var(--accent-soft)]',
].join(' ')

const primaryButtonClass = [
  'rounded-2xl bg-[color:var(--accent)] px-5 py-3 text-sm',
  'font-medium text-white transition hover:opacity-90',
  'disabled:cursor-not-allowed disabled:opacity-60',
].join(' ')

const providerCardClass = [
  'flex items-center justify-between rounded-2xl border',
  'border-[color:var(--line)] bg-white/70 px-4 py-3',
].join(' ')

const errorBoxClass = [
  'rounded-2xl border border-[color:var(--danger)]/30',
  'bg-[color:var(--danger)]/8 px-4 py-3 text-sm',
  'text-[color:var(--danger)]',
].join(' ')

export const LoginPage = () => {
  const navigate = useNavigate()
  const { login, sessionState } = useAuthSession()
  const { data: providers = [] } = useAuthProviders()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (sessionState === 'authenticated') {
      void navigate('/channels', { replace: true })
    }
  }, [navigate, sessionState])

  if (sessionState === 'authenticated') {
    return <Navigate to="/channels" replace />
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)

    try {
      await login({ email, password })
      void navigate('/channels', { replace: true })
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Login failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen px-6 py-10">
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="glass-panel rounded-[2rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--muted)]">
            Sign in
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">
            Open the Nessie workspace.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[color:var(--muted)] md:text-base">
            Use your account to enter channels, create agents, and watch their activity live.
          </p>

          <div className="mt-8 grid gap-3 rounded-[1.5rem] border border-[color:var(--line)] bg-white/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">
              Auth providers
            </div>
            <div className="grid gap-2 text-sm">
              {providers.length > 0 ? (
                providers.map((provider) => (
                  <div key={provider.providerId} className={providerCardClass}>
                    <div>
                      <div className="font-medium">{provider.label}</div>
                      <div className="text-xs text-[color:var(--muted)]">{provider.type}</div>
                    </div>
                    <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--muted)]">
                      {provider.enabled ? 'Enabled' : 'Disabled'}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-[color:var(--muted)]">Loading providers...</div>
              )}
            </div>
          </div>
        </section>

        <section className="glass-panel rounded-[2rem] p-8 md:p-10">
          <h2 className="text-2xl font-semibold">Account</h2>
          <form className="mt-6 grid gap-4" onSubmit={handleSubmit}>
            <label className="grid gap-2 text-sm">
              <span>Email</span>
              <input
                className={fieldClass}
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span>Password</span>
              <input
                className={fieldClass}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>

            {error ? <div className={errorBoxClass}>{error}</div> : null}

            <button className={primaryButtonClass} disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </section>
      </div>
    </main>
  )
}
