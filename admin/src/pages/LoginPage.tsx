import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthProviders } from '../facades/auth/hooks'
import { beginExternalAuth, clearPendingExternalAuth, readPendingExternalAuth } from '../lib/pkce'
import { useAuthSession } from '../providers/AuthSessionProvider'

const LOCAL_DEMO_EMAIL = 'owner@example.com'
const LOCAL_DEMO_PASSWORD = 'Password123!'

const fieldClass = [
  'w-full rounded-2xl border border-[var(--line)]',
  'bg-white/80 px-4 py-3 text-sm text-[var(--ink)]',
  'outline-none transition focus:border-[var(--accent)]',
  'focus:ring-2 focus:ring-[var(--accent-soft)]',
].join(' ')

const primaryButtonClass = [
  'rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm',
  'font-medium text-white transition hover:opacity-90',
  'disabled:cursor-not-allowed disabled:opacity-60',
].join(' ')

const providerCardClass = [
  'flex items-center justify-between rounded-2xl border',
  'border-[var(--line)] bg-white/70 px-4 py-3',
].join(' ')

const errorBoxClass = [
  'rounded-2xl border border-red-500/30',
  'bg-red-500/8 px-4 py-3 text-sm',
  'text-red-300',
].join(' ')

export const LoginPage = () => {
  const navigate = useNavigate()
  const { login, sessionState } = useAuthSession()
  const { data: providers = [] } = useAuthProviders()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const enabledProviders = providers.filter((provider) => provider.enabled)
  const singleEnabledProvider = enabledProviders.length === 1 ? enabledProviders[0] : null
  const autoRedirectProvider =
    singleEnabledProvider &&
    singleEnabledProvider.type !== 'local-bootstrap' &&
    singleEnabledProvider.autoRedirect
      ? singleEnabledProvider
      : null

  useEffect(() => {
    if (sessionState === 'authenticated') {
      void navigate('/channels', { replace: true })
    }
  }, [navigate, sessionState])

  useEffect(() => {
    const hasLocalBootstrapProvider = providers.some(
      (provider) => provider.enabled && provider.type === 'local-bootstrap',
    )
    if (!hasLocalBootstrapProvider) {
      return
    }

    setEmail((current) => current || LOCAL_DEMO_EMAIL)
    setPassword((current) => current || LOCAL_DEMO_PASSWORD)
  }, [providers])

  useEffect(() => {
    if (sessionState !== 'unauthenticated') {
      return
    }

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    if (!code || !state) {
      return
    }

    const pendingExternalAuth = readPendingExternalAuth()
    if (!pendingExternalAuth || pendingExternalAuth.state !== state) {
      clearPendingExternalAuth()
      setError('The external sign-in callback could not be verified.')
      return
    }

    setIsSubmitting(true)
    setError(null)
    void login({
      code,
      codeVerifier: pendingExternalAuth.codeVerifier,
      providerId: pendingExternalAuth.providerId,
      redirectUri: `${window.location.origin}/login`,
    })
      .then(() => {
        clearPendingExternalAuth()
        void navigate('/channels', { replace: true })
      })
      .catch((submitError) => {
        clearPendingExternalAuth()
        setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
      })
      .finally(() => {
        setIsSubmitting(false)
      })
  }, [login, navigate, sessionState])

  useEffect(() => {
    if (sessionState !== 'unauthenticated') {
      return
    }

    if (window.location.search.includes('code=')) {
      return
    }

    if (!autoRedirectProvider) {
      return
    }

    setIsSubmitting(true)
    setError(null)
    void beginExternalAuth(autoRedirectProvider.providerId, `${window.location.origin}/login`)
      .then((authorizeUrl) => {
        window.location.assign(authorizeUrl)
      })
      .catch((submitError) => {
        setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
        setIsSubmitting(false)
      })
  }, [autoRedirectProvider, sessionState])

  if (sessionState === 'authenticated') {
    return <Navigate to="/channels" replace />
  }

  if (sessionState === 'bootstrap') {
    return <Navigate to="/bootstrap" replace />
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

  const handleProviderSignIn = async (providerId: string): Promise<void> => {
    setError(null)
    setIsSubmitting(true)

    try {
      const authorizeUrl = await beginExternalAuth(providerId, `${window.location.origin}/login`)
      window.location.assign(authorizeUrl)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
      setIsSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen px-6 py-10">
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="glass-panel rounded-[2rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
            Sign in
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">
            Open the Nessie workspace.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--muted)] md:text-base">
            Use your account to enter channels, create agents, and watch their activity live.
          </p>

          <div className="mt-8 grid gap-3 rounded-[1.5rem] border border-[var(--line)] bg-white/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-[var(--muted)]">
              Auth providers
            </div>
            <div className="grid gap-2 text-sm">
              {providers.length > 0 ? (
                providers.map((provider) => (
                  <div key={provider.providerId} className={providerCardClass}>
                    <div>
                      <div className="font-medium">{provider.label}</div>
                      <div className="text-xs text-[var(--muted)]">{provider.type}</div>
                    </div>
                    {provider.type === 'local-bootstrap' ? (
                      <div className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
                        {provider.enabled ? 'Enabled' : 'Disabled'}
                      </div>
                    ) : (
                      <button
                        className="text-xs uppercase tracking-[0.18em] text-[var(--accent)] disabled:opacity-50"
                        disabled={isSubmitting || !provider.enabled}
                        onClick={() => void handleProviderSignIn(provider.providerId)}
                        type="button"
                      >
                        {provider.autoRedirect ? 'Auto redirect' : 'Continue'}
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-sm text-[var(--muted)]">Loading providers...</div>
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
                autoComplete="username"
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
                autoComplete="current-password"
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
