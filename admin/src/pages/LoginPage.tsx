import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthProviders } from '../facades/auth/hooks'
import { beginExternalAuth, clearPendingExternalAuth, readPendingExternalAuth } from '../lib/pkce'
import { useAuthSession } from '../providers/AuthSessionProvider'

const LOCAL_DEMO_EMAIL = 'owner@example.com'
const LOCAL_DEMO_PASSWORD = 'Password123!'

const fieldClass = [
  'w-full rounded-2xl border border-[var(--line)]',
  'bg-[color:var(--surface-inverse)] px-4 py-3 text-sm text-[var(--ink)]',
  'outline-none transition focus:border-[var(--accent)]',
  'focus:ring-2 focus:ring-[var(--accent-soft)]',
].join(' ')

const primaryButtonClass = [
  'w-full rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm',
  'font-medium text-[color:var(--on-accent)] transition hover:opacity-90',
  'disabled:cursor-not-allowed disabled:opacity-60',
].join(' ')

const errorBoxClass = [
  'rounded-2xl border border-[color:var(--danger-border)]',
  'bg-[color:var(--danger-soft)] px-4 py-3 text-sm',
  'text-[color:var(--danger-text)]',
].join(' ')

export const LoginPage = () => {
  const navigate = useNavigate()
  const { devLogin, login, sessionState } = useAuthSession()
  const { data: providers = [] } = useAuthProviders()
  // Pre-filled dev credentials for convenience (local mode only).
  const [email, setEmail] = useState(LOCAL_DEMO_EMAIL)
  const [password, setPassword] = useState(LOCAL_DEMO_PASSWORD)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // The API only advertises a `local-bootstrap` provider when running in local
  // mode. Internal email/password + dev login are therefore local-only; in
  // hosted/self-hosted production the sole sign-in path is SSO.
  const localModeEnabled = providers.some((provider) => provider.type === 'local-bootstrap')
  const ssoProviders = providers.filter(
    (provider) => provider.enabled && provider.type !== 'local-bootstrap',
  )
  const singleSsoProvider = ssoProviders.length === 1 ? ssoProviders[0] : null
  const autoRedirectProvider =
    singleSsoProvider && singleSsoProvider.autoRedirect ? singleSsoProvider : null

  useEffect(() => {
    if (sessionState === 'authenticated') {
      void navigate('/channels', { replace: true })
    }
  }, [navigate, sessionState])

  useEffect(() => {
    if (sessionState !== 'unauthenticated') {
      return
    }

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    if (!code) {
      return
    }

    // Some providers (e.g. UOA) do not echo `state` on the callback — PKCE plus
    // the same-origin sessionStorage entry already bind this exchange. Only
    // enforce a state match when the provider actually returned one.
    const pendingExternalAuth = readPendingExternalAuth()
    if (!pendingExternalAuth || (state !== null && pendingExternalAuth.state !== state)) {
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

  const handleDevLogin = async (): Promise<void> => {
    setError(null)
    setIsSubmitting(true)

    try {
      await devLogin()
      void navigate('/channels', { replace: true })
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Dev login failed')
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
      <div className="mx-auto grid max-w-6xl items-start gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="glass-panel relative self-start rounded-[2rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
            Sign in
          </p>
          <h1 className="mt-4 max-w-[26rem] text-4xl font-semibold tracking-tight text-[color:var(--tx)] md:text-5xl">
            Open the Nessie workspace.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--muted)] md:text-base">
            Use your account to enter channels, create agents, and watch their activity live.
          </p>
          <img
            alt="Nessie icon"
            className={[
              'absolute right-8 top-8 h-[100px] w-[100px] rounded-[1.75rem] object-cover',
              'shadow-[0_20px_40px_var(--scrim)]',
            ].join(' ')}
            src="/icon-1024.png"
          />
        </section>

        <section className="glass-panel self-start rounded-[2rem] p-8 md:p-10">
          <h2 className="text-2xl font-semibold text-[color:var(--tx)]">Sign in</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Continue with single sign-on to access your workspace.
          </p>

          <div className="mt-6 grid gap-3">
            {ssoProviders.length > 0 ? (
              ssoProviders.map((provider) => (
                <button
                  key={provider.providerId}
                  className={primaryButtonClass}
                  disabled={isSubmitting}
                  onClick={() => void handleProviderSignIn(provider.providerId)}
                  type="button"
                >
                  {isSubmitting ? 'Signing in...' : provider.label}
                </button>
              ))
            ) : (
              <div className="text-sm text-[var(--muted)]">
                {providers.length === 0
                  ? 'Loading providers...'
                  : 'No sign-in providers are configured.'}
              </div>
            )}
            {error ? <div className={errorBoxClass}>{error}</div> : null}
          </div>

          {localModeEnabled ? (
            <div className="mt-6 border-t border-[var(--line)] pt-6">
              <p className="text-xs uppercase tracking-[0.24em] text-[var(--muted)]">
                Local development
              </p>
              <form className="mt-4 grid gap-4" onSubmit={handleSubmit}>
                <label className="grid gap-2 text-sm text-[color:var(--tx)]">
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
                <label className="grid gap-2 text-sm text-[color:var(--tx)]">
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
                <button className={primaryButtonClass} disabled={isSubmitting} type="submit">
                  {isSubmitting ? 'Signing in...' : 'Sign in'}
                </button>
              </form>
              <button
                className={[
                  'mt-3 w-full rounded-2xl border border-[var(--line)]',
                  'bg-[color:var(--overlay)] px-5 py-3 text-sm font-medium',
                  'text-[var(--muted)] transition hover:bg-[color:var(--overlay-strong)]',
                  'hover:text-[color:var(--tx)] disabled:cursor-not-allowed disabled:opacity-60',
                ].join(' ')}
                disabled={isSubmitting}
                onClick={() => void handleDevLogin()}
                type="button"
              >
                {isSubmitting ? 'Signing in...' : 'Dev Login (skip password)'}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  )
}
