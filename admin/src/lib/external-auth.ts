import type { AppliedTheme } from '../providers/ThemeProvider'
import { isDesktopApp } from './desktop'
import { isReactNativeWebView } from './mobile-shell'
import { beginExternalAuth } from './pkce'

// Embedded webviews (Tauri desktop + React Native mobile) cannot run Google
// OAuth inline — Google blocks embedded user-agents. They round-trip through the
// OS browser and return via this deep link; the web SPA returns to /login.
export const DESKTOP_REDIRECT_URI = 'nessie://auth/callback'

type RnWebViewWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
}

export const externalAuthRedirectUri = (): string =>
  isDesktopApp() || isReactNativeWebView()
    ? DESKTOP_REDIRECT_URI
    : `${window.location.origin}/login`

/**
 * Kick off an SSO authorize flow for a provider from whichever surface we are on
 * (OS browser on desktop/mobile, full-page redirect on web). Shared by the login
 * screen and the in-app "add a workspace" action so both start SSO identically.
 */
export const startExternalSignIn = async (
  providerId: string,
  theme: AppliedTheme,
  teamHint?: string,
): Promise<void> => {
  const redirectUri = externalAuthRedirectUri()
  const authorizeUrl = await beginExternalAuth(providerId, redirectUri, theme, teamHint)

  if (isDesktopApp()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(authorizeUrl)
    return
  }

  const mobileWebView = (window as RnWebViewWindow).ReactNativeWebView
  if (mobileWebView) {
    // Hand the authorize URL to the native shell; it opens the OS browser
    // (ASWebAuthenticationSession) and posts the callback URL back to the SPA.
    mobileWebView.postMessage(JSON.stringify({ type: 'nessie:external-auth', url: authorizeUrl }))
    return
  }

  window.location.assign(authorizeUrl)
}
