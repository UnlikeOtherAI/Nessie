import type { PendingExternalAuthTarget } from '@nessie/client-core'
import type { AppliedTheme } from '../providers/ThemeProvider'
import { isDesktopApp } from './desktop'
import { isReactNativeWebView } from './mobile-shell'
import {
  beginExternalAuth,
  clearPendingExternalAuthMatching,
} from './pkce'

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

export type ExternalSignInOptions = {
  // App route to land on after the exchange completes (defaults to /channels).
  returnPath?: string
  // Exact external workspace a reauthorization flow must land on.
  targetWorkspace?: PendingExternalAuthTarget
  teamHint?: string
}

const openAuthorizeUrl = async (authorizeUrl: string, state: string | undefined): Promise<void> => {
  if (isDesktopApp()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(authorizeUrl)
    return
  }

  const mobileWebView = (window as RnWebViewWindow).ReactNativeWebView
  if (mobileWebView) {
    // Hand the authorize URL to the native shell; it opens the OS browser
    // (ASWebAuthenticationSession) and posts the callback URL back to the SPA.
    mobileWebView.postMessage(JSON.stringify({
      type: 'nessie:external-auth',
      url: authorizeUrl,
      ...(state ? { state } : {}),
    }))
    return
  }

  window.location.assign(authorizeUrl)
}

/**
 * Kick off an SSO authorize flow for a provider from whichever surface we are on
 * (OS browser on desktop/mobile, full-page redirect on web). Shared by the login
 * screen, the in-app "add a workspace" action, and workspace-switch
 * reauthorization so every entry point starts SSO identically.
 */
export const startExternalSignIn = async (
  providerId: string,
  theme: AppliedTheme,
  options: ExternalSignInOptions = {},
): Promise<void> => {
  const redirectUri = externalAuthRedirectUri()
  const { authorizeUrl, state: launchedState } = await beginExternalAuth({
    providerId,
    redirectUri,
    ...(options.returnPath ? { returnPath: options.returnPath } : {}),
    ...(options.targetWorkspace ? { targetWorkspace: options.targetWorkspace } : {}),
    ...(options.teamHint ? { teamHint: options.teamHint } : {}),
    theme,
  })
  try {
    await openAuthorizeUrl(authorizeUrl, launchedState)
  } catch (error) {
    if (launchedState) clearPendingExternalAuthMatching(launchedState)
    throw error
  }
}

/**
 * Workspace-switch reauthorization: SSO pre-hinted at the exact workspace the
 * switch targeted, preserving the return path so the recovered session lands
 * back where the person was standing.
 */
export const startWorkspaceSwitchReauthorization = async (input: {
  providerId: string
  targetWorkspace: PendingExternalAuthTarget
  theme: AppliedTheme
}): Promise<void> =>
  startExternalSignIn(input.providerId, input.theme, {
    returnPath: window.location.pathname + window.location.search,
    targetWorkspace: input.targetWorkspace,
    teamHint: input.targetWorkspace.teamId,
  })
