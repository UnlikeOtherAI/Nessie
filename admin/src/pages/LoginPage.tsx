import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { faLock } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AppDownloads, SignInShowcase, SignInSurface } from '@nessie/sign-in-surface'
import { useRedirect } from '../navigation/redirect'
import { Input } from '../components/shared/FormControls'
import { LoginSessionImportButton } from '../components/shared/LoginSessionImportButton'
import { useAuthProviders } from '../facades/auth/hooks'
import { getBaseUrl } from '../lib/api-client'
import { startExternalSignIn } from '../lib/external-auth'
import { desktopPlatform, isDesktopApp } from '../lib/desktop'
import { isReactNativeWebView } from '../lib/mobile-shell'
import { clearPendingExternalAuth, readPendingExternalAuth } from '../lib/pkce'
import { shouldStartAutomaticSignIn } from '../lib/session-debug-import'
import { subscribeToNativeExternalAuthResults } from '../lib/native-external-auth'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { resolveAppliedTheme, useTheme } from '../providers/ThemeProvider'

const LOCAL_DEMO_EMAIL = 'owner@example.com'
const LOCAL_DEMO_PASSWORD = 'Password123!'

/**
 * `/login?launch=sso` is the public landing's sign-in link. The PKCE verifier
 * has to be minted on this origin, so nessie.works cannot open the provider
 * itself: it hands off here and this screen starts the flow at once instead of
 * showing the same button a second time. The flag is consumed on launch so a
 * reload, or Back from the provider, lands on the ordinary screen.
 */
export const SSO_LAUNCH_PARAM = 'launch'
export const SSO_LAUNCH_VALUE = 'sso'

export const LoginPage = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const redirect = useRedirect()
  const { devLogin, login, sessionState } = useAuthSession()
  const { theme } = useTheme()
  const {
    data: providers = [],
    error: providersError,
    isPending: providersPending,
    refetch: refetchProviders,
  } = useAuthProviders(sessionState === 'unauthenticated')
  // Pre-filled dev credentials for convenience (local mode only).
  const [email, setEmail] = useState(LOCAL_DEMO_EMAIL)
  const [password, setPassword] = useState(LOCAL_DEMO_PASSWORD)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [sessionImportOpen, setSessionImportOpen] = useState(false)
  const showMobileSessionImport = sessionState === 'unauthenticated' && isReactNativeWebView()
  const showWindowsSessionImport = sessionState === 'unauthenticated'
    && desktopPlatform() === 'linux'
  // Someone already inside the desktop or mobile shell has the app.
  const showDownloads = !isDesktopApp() && !isReactNativeWebView()
  const launchRequested =
    new URLSearchParams(location.search).get(SSO_LAUNCH_PARAM) === SSO_LAUNCH_VALUE

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
  const automaticProvider = autoRedirectProvider
    ?? (launchRequested ? singleSsoProvider ?? ssoProviders[0] ?? null : null)

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
      launchRequested,
      sessionImportOpen,
      unauthenticated: sessionState === 'unauthenticated',
    }) || !automaticProvider || readPendingExternalAuth()) {
      return
    }

    setIsSubmitting(true)
    setError(null)
    if (launchRequested) {
      void navigate({ pathname: location.pathname }, { replace: true })
    }
    void beginSsoSignIn(automaticProvider.providerId)
      .catch((submitError) => {
        clearPendingExternalAuth()
        setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
        setIsSubmitting(false)
      })
  }, [
    autoRedirectProvider,
    automaticProvider,
    beginSsoSignIn,
    launchRequested,
    location.pathname,
    navigate,
    sessionImportOpen,
    sessionState,
  ])

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
    <>
      <SignInSurface
        after={showDownloads ? <AppDownloads /> : null}
        // Clear the floating session-import control in the mobile WebView so it
        // never covers the last row of the column.
        columnStyle={showMobileSessionImport ? {
          paddingBottom: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))',
        } : undefined}
        logo={(
          <img
            alt=""
            className="signin-wordmark-mark"
            onError={(event) => {
              const img = event.currentTarget
              if (img.src.endsWith('/icon-1024.png')) return
              img.src = '/icon-1024.png'
            }}
            src={`${getBaseUrl()}/api/brand/logo`}
          />
        )}
        productName="Nessie"
        showcase={<SignInShowcase />}
      >
        {ssoProviders.length > 0 ? (
          ssoProviders.map((provider) => (
            <button
              className="signin-cta signin-cta-primary"
              disabled={isSubmitting}
              key={provider.providerId}
              onClick={() => void handleProviderSignIn(provider.providerId)}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" className="signin-cta-icon" icon={faLock} />
              {isSubmitting ? 'Signing in...' : provider.label}
            </button>
          ))
        ) : providersError ? (
          <div className="grid gap-3" role="alert">
            <p className="signin-alert">
              Couldn&apos;t load sign-in options. Check your connection and try again.
            </p>
            <button
              className="signin-cta signin-cta-secondary"
              disabled={isSubmitting}
              onClick={() => void refetchProviders()}
              type="button"
            >
              Retry loading sign-in options
            </button>
          </div>
        ) : (
          <p className="signin-note">
            {sessionState === 'loading' || providersPending
              ? 'Loading sign-in options...'
              : 'No sign-in providers are configured.'}
          </p>
        )}
        {error ? <p className="signin-alert" role="alert">{error}</p> : null}
        {isSubmitting ? (
          <p className="signin-note">
            <button className="signin-link" onClick={cancelProviderSignIn} type="button">
              Cancel sign-in
            </button>
          </p>
        ) : null}

        {showWindowsSessionImport ? (
          <div className="signin-section">
            <p className="signin-note">
              Already signed in to Nessie on Windows? Copy Session debug there,
              then bring that session into this Linux app.
            </p>
            <LoginSessionImportButton
              label="Use Windows session"
              onOpenChange={setSessionImportOpen}
              variant="inline"
            />
          </div>
        ) : null}

        {localModeEnabled ? (
          <form className="signin-section" onSubmit={handleSubmit}>
            <p className="signin-section-title">Local development</p>
            <label className="signin-field">
              <span>Email</span>
              <Input
                autoComplete="username"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label className="signin-field">
              <span>Password</span>
              <Input
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            <button className="signin-cta signin-cta-primary" disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Signing in...' : 'Sign in'}
            </button>
            <button
              className="signin-cta signin-cta-secondary"
              disabled={isSubmitting}
              onClick={() => void handleDevLogin()}
              type="button"
            >
              {isSubmitting ? 'Signing in...' : 'Dev login (skip password)'}
            </button>
          </form>
        ) : null}
      </SignInSurface>

      {showMobileSessionImport ? (
        <LoginSessionImportButton onOpenChange={setSessionImportOpen} />
      ) : null}
    </>
  )
}
