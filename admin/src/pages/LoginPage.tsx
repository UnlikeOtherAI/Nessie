import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthProviders } from '../facades/auth/hooks'
import { getBaseUrl } from '../lib/api-client'
import { isDesktopApp } from '../lib/desktop'
import { isReactNativeWebView } from '../lib/mobile-shell'
import { beginExternalAuth, clearPendingExternalAuth, readPendingExternalAuth } from '../lib/pkce'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { resolveAppliedTheme, useTheme, type Theme } from '../providers/ThemeProvider'

const LOCAL_DEMO_EMAIL = 'owner@example.com'
const LOCAL_DEMO_PASSWORD = 'Password123!'
const DESKTOP_REDIRECT_URI = 'nessie://auth/callback'

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

type ExternalSignInCallback = {
  code: string
  redirectUri: string
  state: string | null
}

const webRedirectUri = (): string => `${window.location.origin}/login`

type RnWebViewWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
}

const reactNativeWebView = (): RnWebViewWindow['ReactNativeWebView'] =>
  (window as RnWebViewWindow).ReactNativeWebView

// Embedded webviews (Tauri desktop + React Native mobile) cannot run Google
// OAuth inline — Google blocks embedded user-agents (error 403
// disallowed_useragent). They round-trip through the OS browser and return via
// the nessie:// deep link instead.
const externalAuthRedirectUri = (): string =>
  isDesktopApp() || isReactNativeWebView() ? DESKTOP_REDIRECT_URI : webRedirectUri()

const parseDesktopAuthCallback = (value: string): Omit<ExternalSignInCallback, 'redirectUri'> | null => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'nessie:' || url.hostname !== 'auth' || url.pathname !== '/callback') {
    return null
  }

  const code = url.searchParams.get('code')
  if (!code) {
    return null
  }

  return { code, state: url.searchParams.get('state') }
}

export const LoginPage = () => {
  const navigate = useNavigate()
  const { devLogin, login, sessionState } = useAuthSession()
  const { setTheme, theme, themes } = useTheme()
  const { data: providers = [] } = useAuthProviders()
  const handledDesktopCallbackUrls = useRef(new Set<string>())
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

  const completeExternalSignIn = useCallback(
    async ({ code, redirectUri, state }: ExternalSignInCallback): Promise<void> => {
      // Some providers (e.g. UOA) do not echo `state` on the callback — PKCE plus
      // the sessionStorage entry already bind this exchange. Only enforce a
      // state match when the provider actually returned one.
      const pendingExternalAuth = readPendingExternalAuth()
      if (!pendingExternalAuth) {
        // No sign-in is in progress (e.g. a stale deep link replayed after a
        // logout/relaunch) — nothing to verify, so ignore quietly.
        return
      }
      if (state !== null && pendingExternalAuth.state !== state) {
        clearPendingExternalAuth()
        setError('The external sign-in callback could not be verified.')
        return
      }

      setIsSubmitting(true)
      setError(null)

      try {
        await login({
          code,
          codeVerifier: pendingExternalAuth.codeVerifier,
          providerId: pendingExternalAuth.providerId,
          redirectUri,
        })
        clearPendingExternalAuth()
        void navigate('/channels', { replace: true })
      } catch (submitError) {
        clearPendingExternalAuth()
        setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
      } finally {
        setIsSubmitting(false)
      }
    },
    [login, navigate],
  )

  const startExternalSignIn = useCallback(async (providerId: string): Promise<void> => {
    const redirectUri = externalAuthRedirectUri()
    const authorizeUrl = await beginExternalAuth(providerId, redirectUri, resolveAppliedTheme(theme))

    if (isDesktopApp()) {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(authorizeUrl)
      return
    }

    const mobileWebView = reactNativeWebView()
    if (mobileWebView) {
      // Hand the authorize URL to the native shell; it opens the OS browser
      // (ASWebAuthenticationSession) and posts the callback URL back to
      // window.__nessieExternalAuthCallback below.
      mobileWebView.postMessage(JSON.stringify({ type: 'nessie:external-auth', url: authorizeUrl }))
      return
    }

    window.location.assign(authorizeUrl)
  }, [theme])

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

    void completeExternalSignIn({ code, redirectUri: webRedirectUri(), state })
  }, [completeExternalSignIn, sessionState])

  // Mobile shell delivers the OS-browser OAuth callback URL here — the analogue
  // of the desktop deep-link listener below.
  useEffect(() => {
    if (sessionState !== 'unauthenticated' || !isReactNativeWebView()) {
      return undefined
    }

    const target = window as Window & { __nessieExternalAuthCallback?: (url: string) => void }
    target.__nessieExternalAuthCallback = (url: string) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return
      }
      const code = parsed.searchParams.get('code')
      if (!code) {
        return
      }
      void completeExternalSignIn({
        code,
        redirectUri: DESKTOP_REDIRECT_URI,
        state: parsed.searchParams.get('state'),
      })
    }

    return () => {
      delete target.__nessieExternalAuthCallback
    }
  }, [completeExternalSignIn, sessionState])

  useEffect(() => {
    if (sessionState !== 'unauthenticated' || !isDesktopApp()) {
      return undefined
    }

    let disposed = false
    let unlisten: (() => void) | undefined
    const handleUrl = (url: string): void => {
      if (handledDesktopCallbackUrls.current.has(url)) {
        return
      }

      const callback = parseDesktopAuthCallback(url)
      if (!callback) {
        return
      }

      handledDesktopCallbackUrls.current.add(url)
      void completeExternalSignIn({
        code: callback.code,
        redirectUri: DESKTOP_REDIRECT_URI,
        state: callback.state,
      })
    }

    const readDeepLinks = async (): Promise<void> => {
      const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
      const currentUrls = await getCurrent()
      if (disposed) {
        return
      }

      for (const url of currentUrls ?? []) {
        handleUrl(url)
      }

      unlisten = await onOpenUrl((urls) => {
        for (const url of urls) {
          handleUrl(url)
        }
      })

      if (disposed) {
        unlisten()
      }
    }

    void readDeepLinks().catch((submitError) => {
      setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [completeExternalSignIn, sessionState])

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
    void startExternalSignIn(autoRedirectProvider.providerId)
      .catch((submitError) => {
        setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
        setIsSubmitting(false)
      })
  }, [autoRedirectProvider, sessionState, startExternalSignIn])

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
      await startExternalSignIn(providerId)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Sign-in failed')
      setIsSubmitting(false)
    }
  }

  return (
    <main
      className="relative flex h-[100dvh] flex-col overflow-y-auto px-6"
      style={{
        // Clear the device status bar / home indicator in the mobile WebView
        // (viewport-fit=cover is injected by the native shell). env() is 0 on
        // web/desktop, so this is a no-op there.
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 2.5rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2.5rem)',
      }}
    >
      <div className="mx-auto grid max-w-6xl items-start gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="glass-panel flex flex-col gap-8 self-stretch rounded-[2rem] p-8 md:p-10">
          <img
            alt="Workspace logo"
            className="h-[88px] w-[88px] rounded-[1.5rem] object-cover shadow-[0_20px_40px_var(--scrim)]"
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

      <div className="mx-auto mt-auto flex w-full max-w-6xl items-center justify-end gap-3 pt-8">
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
    </main>
  )
}
