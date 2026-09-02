import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useRedirect } from '../navigation/redirect'
import { LoginSessionImportButton } from '../components/shared/LoginSessionImportButton'
import { useAuthProviders } from '../facades/auth/hooks'
import { getBaseUrl } from '../lib/api-client'
import { startExternalSignIn } from '../lib/external-auth'
import { isDesktopApp } from '../lib/desktop'
import { isReactNativeWebView } from '../lib/mobile-shell'
import { clearPendingExternalAuth, readPendingExternalAuth } from '../lib/pkce'
import { shouldStartAutomaticSignIn } from '../lib/session-debug-import'
import { subscribeToNativeExternalAuthResults } from '../lib/native-external-auth'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { resolveAppliedTheme, useTheme, type Theme } from '../providers/ThemeProvider'
import { identityTileRadius } from '../components/primitives/identity-shape'

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
  const redirect = useRedirect()
  const { devLogin, login, sessionState } = useAuthSession()
  const { setTheme, theme, themes } = useTheme()
  const { data: providers = [] } = useAuthProviders()
  // Pre-filled dev credentials for convenience (local mode only).
  const [email, setEmail] = useState(LOCAL_DEMO_EMAIL)
  const [password, setPassword] = useState(LOCAL_DEMO_PASSWORD)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [sessionImportOpen, setSessionImportOpen] = useState(false)
  const showSessionImport = sessionState === 'unauthenticated' && isReactNativeWebView()

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

  const beginSsoSignIn = useCallback(
    (providerId: string): Promise<void> => startExternalSignIn(providerId, resolveAppliedTheme(theme)),
    [theme],
  )

  useEffect(() => {
    if (sessionState === 'authenticated') {
      redirect('/channels')
    }
  }, [redirect, sessionState])

  // Native cancel/failure results settle this screen's submitting state; the
  // successful callback URL continues through the always-mounted external-auth
  // provider instead.
  useEffect(() => {
    if (sessionState !== 'unauthenticated' || !isReactNativeWebView()) {
      return undefined
    }

    return subscribeToNativeExternalAuthResults(window, {
      clearPendingAuth: clearPendingExternalAuth,
      setError,
      setSubmitting: setIsSubmitting,
    })
  }, [sessionState])

  useEffect(() => {
    // A web SSO launch leaves this document for the provider. If the browser
    // restores it from its back/forward cache, its old React state still says
    // "Signing in" and the pending PKCE record would otherwise trap the
    // person between the app and the provider. Returning with Back is an
    // explicit cancellation, not a request to launch again.
    if (isDesktopApp() || isReactNativeWebView()) return undefined

    const cancelReturnedWebSignIn = (event: PageTransitionEvent): void => {
      if (!event.persisted) return
      clearPendingExternalAuth()
      setError(null)
      setIsSubmitting(false)
    }

    window.addEventListener('pageshow', cancelReturnedWebSignIn)
    return () => window.removeEventListener('pageshow', cancelReturnedWebSignIn)
  }, [])

  useEffect(() => {
    if (!shouldStartAutomaticSignIn({
      hasAutoRedirectProvider: Boolean(autoRedirectProvider),
      sessionImportOpen,
      unauthenticated: sessionState === 'unauthenticated',
    }) || !autoRedirectProvider || readPendingExternalAuth()) {
      return
    }

    setIsSubmitting(true)
    setError(null)
    void beginSsoSignIn(autoRedirectProvider.providerId)
      .catch((submitError) => {
        clearPendingExternalAuth()
        setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
        setIsSubmitting(false)
      })
  }, [autoRedirectProvider, beginSsoSignIn, sessionImportOpen, sessionState])

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
      await beginSsoSignIn(providerId)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
    } finally {
      // The native shell resolves after it has posted the launch request to
      // ASWebAuthenticationSession. The callback exchange happens later, so
      // this button must not claim it is still submitting in the meantime.
      if (isReactNativeWebView()) setIsSubmitting(false)
    }
  }

  const cancelProviderSignIn = (): void => {
    clearPendingExternalAuth()
    setError(null)
    setIsSubmitting(false)
  }

  return (
    <main
      className="relative flex h-[100dvh] min-h-0 touch-pan-y flex-col overflow-y-scroll overscroll-y-contain px-6"
      style={{
        // Clear the device status bar / home indicator in the mobile WebView
        // (viewport-fit=cover is injected by the native shell). env() is 0 on
        // web/desktop, so this is a no-op there.
        WebkitOverflowScrolling: 'touch',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 2.5rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2.5rem)',
      }}
    >
      <div className="mx-auto grid w-full max-w-6xl items-start gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="glass-panel order-2 flex flex-col gap-8 self-stretch rounded-[2rem] p-8 md:p-10 lg:order-1">
          <img
            alt="Workspace logo"
            className="h-[88px] w-[88px] object-cover shadow-[0_20px_40px_var(--scrim)]"
            style={{ borderRadius: identityTileRadius(88) }}
            onError={(event) => {
              const img = event.currentTarget
              if (img.src.endsWith('/icon-1024.png')) return
              img.src = '/icon-1024.png'
            }}
            src={`${getBaseUrl()}/api/brand/logo`}
          />
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
              Sign in
            </p>
            <h1 className="mt-4 max-w-[26rem] text-4xl font-semibold tracking-tight text-[color:var(--tx)] md:text-5xl">
              Open the Nessie workspace.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--muted)] md:text-base">
              Use your account to enter channels, create agents, and watch their activity live.
            </p>
          </div>
        </section>

        <section className="glass-panel order-1 self-start rounded-[2rem] p-8 md:p-10 lg:order-2">
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
            {isSubmitting ? (
              <button
                className="text-sm font-medium text-[var(--muted)] underline underline-offset-4 transition hover:text-[color:var(--tx)]"
                onClick={cancelProviderSignIn}
                type="button"
              >
                Cancel sign-in
              </button>
            ) : null}
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

      <div
        className="mx-auto mt-auto flex w-full max-w-6xl items-center justify-end gap-3 pt-8"
        style={showSessionImport ? {
          paddingRight: 'calc(3.5rem + env(safe-area-inset-right, 0px))',
        } : undefined}
      >
        <span className="text-xs uppercase tracking-[0.24em] text-[var(--muted)]">
          Theme
        </span>
        <select
          aria-label="Theme"
          className="rounded-xl border border-[var(--line)] bg-[color:var(--surface-inverse)] px-3 py-2 text-sm text-[var(--ink)] outline-none transition focus:border-[var(--accent)]"
          onChange={(event) => setTheme(event.target.value as Theme)}
          value={theme}
        >
          {themes.map((themeOption) => (
            <option key={themeOption.id} value={themeOption.id}>
              {themeOption.label}
            </option>
          ))}
        </select>
      </div>

      {showSessionImport ? (
        <LoginSessionImportButton onOpenChange={setSessionImportOpen} />
      ) : null}
    </main>
  )
}
