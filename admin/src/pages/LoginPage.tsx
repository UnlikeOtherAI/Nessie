import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { faCheck, faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Navigate, useNavigate } from 'react-router-dom'
import { useRedirect } from '../navigation/redirect'
import { Popover } from '../components/overlays/Popover'
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

const LoginThemeSelector = () => {
  const { setTheme, theme, themes } = useTheme()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const selectedTheme = themes.find((option) => option.id === theme) ?? themes[0]

  const openSelector = (preferredIndex?: number): void => {
    const selectedIndex = themes.findIndex((option) => option.id === theme)
    setActiveIndex(preferredIndex ?? Math.max(0, selectedIndex))
    setOpen(true)
  }

  const selectTheme = (index: number): void => {
    const option = themes[index]
    if (!option) return
    setTheme(option.id)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        openSelector(event.key === 'ArrowUp' ? themes.length - 1 : undefined)
      }
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((index) => (index + step + themes.length) % themes.length)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : themes.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectTheme(activeIndex)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <>
      <button
        aria-activedescendant={open ? `${listboxId}-${themes[activeIndex]?.id}` : undefined}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Theme"
        className={[
          'inline-flex min-w-36 items-center justify-between gap-3 rounded-xl',
          'border border-[var(--line)] bg-[color:var(--surface-inverse)]',
          'px-3 py-2 text-left text-sm text-[var(--ink)] outline-none transition',
          'hover:bg-[color:var(--surface-inverse-2)] focus:border-[var(--accent)]',
          'focus:ring-2 focus:ring-[var(--accent-soft)]',
        ].join(' ')}
        onBlur={() => setOpen(false)}
        onClick={() => (open ? setOpen(false) : openSelector())}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span>{selectedTheme?.label}</span>
        <FontAwesomeIcon
          aria-hidden="true"
          className={`text-[10px] transition-transform${open ? ' rotate-180' : ''}`}
          icon={faChevronDown}
        />
      </button>
      <Popover
        anchorRef={triggerRef}
        className={[
          'overflow-hidden rounded-xl border border-[color:var(--line)]',
          'bg-[color:var(--surface-inverse)] p-1',
          'shadow-[0_18px_45px_var(--scrim)]',
        ].join(' ')}
        id={listboxId}
        label="Theme"
        matchAnchorWidth
        onClose={() => setOpen(false)}
        open={open}
        placement="top-end"
        role="listbox"
      >
        {themes.map((themeOption, index) => {
          const selected = themeOption.id === theme
          const active = index === activeIndex
          return (
            <button
              aria-selected={selected}
              className={[
                'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2',
                'text-left text-sm text-[color:var(--ink)] outline-none transition',
                active ? 'bg-[color:var(--surface-inverse-2)]' : '',
              ].join(' ')}
              id={`${listboxId}-${themeOption.id}`}
              key={themeOption.id}
              onClick={() => selectTheme(index)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
              type="button"
            >
              <span>{themeOption.label}</span>
              <FontAwesomeIcon
                aria-hidden="true"
                className={selected ? 'text-[color:var(--accent)]' : 'invisible'}
                icon={faCheck}
              />
            </button>
          )
        })}
      </Popover>
    </>
  )
}

export const LoginPage = () => {
  const navigate = useNavigate()
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
      className="relative flex h-[var(--app-vh)] min-h-0 touch-pan-y flex-col overflow-y-scroll overscroll-y-contain px-6"
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
            alt="Team logo"
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
              Open the Nessie team.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--muted)] md:text-base">
              Use your account to enter channels, create agents, and watch their activity live.
            </p>
          </div>
        </section>

        <section className="glass-panel order-1 self-start rounded-[2rem] p-8 md:p-10 lg:order-2">
          <h2 className="text-2xl font-semibold text-[color:var(--tx)]">Sign in</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Continue with single sign-on to access your team.
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
            ) : providersError ? (
              <div className="grid gap-3" role="alert">
                <p className={errorBoxClass}>
                  Couldn&apos;t load sign-in options. Check your connection and try again.
                </p>
                <button
                  className={primaryButtonClass}
                  disabled={isSubmitting}
                  onClick={() => void refetchProviders()}
                  type="button"
                >
                  Retry loading sign-in options
                </button>
              </div>
            ) : (
              <div className="text-sm text-[var(--muted)]">
                {sessionState === 'loading' || providersPending
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
            {showWindowsSessionImport ? (
              <div className="mt-2 grid gap-3 border-t border-[var(--line)] pt-5">
                <p className="text-sm leading-6 text-[var(--muted)]">
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
        style={showMobileSessionImport ? {
          paddingRight: 'calc(3.5rem + env(safe-area-inset-right, 0px))',
        } : undefined}
      >
        <span className="text-xs uppercase tracking-[0.24em] text-[var(--muted)]">
          Theme
        </span>
        <LoginThemeSelector />
      </div>

      {showMobileSessionImport ? (
        <LoginSessionImportButton onOpenChange={setSessionImportOpen} />
      ) : null}
    </main>
  )
}
