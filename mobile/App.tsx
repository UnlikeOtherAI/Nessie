import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppState,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'
import { ADMIN_URL } from './src/config'
import { startDevInspector } from './src/lib/dev-inspector'
import {
  dismissNativeNotificationCards,
  getNativePushRegistration,
  reconcileNativeAttentionPresentation,
  subscribeToPushTokenChanges,
  type NativePushRegistration,
} from './src/lib/push-notifications'
import { useNativePushNavigation } from './src/lib/native-push-navigation'
import {
  createNativePushSurfaceClientId,
  nativeAppForegroundScript,
  nativePushPathScript,
  nativeShellInfoScript,
} from './src/lib/native-shell'
import { type NativeShellMessage } from './src/lib/native-shell-message'
import { TABS, tabIndexForPath } from './src/lib/tabs'
import { DEFAULT_BG, INJECTED, isDark, parseRgb } from './src/lib/webview-inject'
import { statusBarStyleForScheme } from './src/lib/status-bar'
import {
  createIpadNativeChromeTheme,
  getIpadChromeTop,
  withOpacity,
} from './src/lib/ipad-native-chrome'
import {
  ANDROID_TABLET_TAB_BAR_BOTTOM_GAP,
} from './src/lib/android-tablet-dock'
import { AndroidTabletTabBar } from './src/components/AndroidTabletTabBar'
import {
  DEFAULT_TOOLBAR_STATE,
  type ToolbarState,
} from './src/components/IpadNativeToolbar'
import { IpadNativeChrome } from './src/components/IpadNativeChrome'
import {
  NativePhoneConversationMenuChrome,
} from './src/components/NativePhoneConversationMenuChrome'
import { IphoneNativeTabBar } from './src/components/IphoneNativeTabBar'
import { completeExternalAuth } from './src/lib/external-auth-session'
import { createNativeWebviewActions } from './src/lib/native-webview-actions'
import {
  createNativeTabNavigationState,
  getNativeWebviewFrameInsets,
  isAuthGateRoute,
  isFullScreenTaskRoute,
  isNativePhoneConversationMenuRoute,
} from './src/lib/native-shell-layout'
const IS_IPAD = Platform.OS === 'ios' && Platform.isPad
const IS_ANDROID = Platform.OS === 'android'
const NATIVE_PUSH_TOKEN_EVENT = 'nessie:native-push-token'
const DEFAULT_ACTIVE_TINT = '#7c3aed'
const DEFAULT_STRONG_ACTIVE_TINT = '#5b21b6'
const DEFAULT_INACTIVE_TINT = '#8a8f98'
const DEFAULT_IPAD_CHROME_SURFACE = '#222629'
const DEFAULT_PHONE_HEADER_SURFACE = '#2b2018'
const DEFAULT_PHONE_HEADER_TEXT = '#fffdf8'
const DEFAULT_PHONE_TEXT = '#2b2018'
const DEFAULT_PHONE_TEXT_MUTED = '#74665b'

// If the admin never reports itself mounted (it posts a `nessie:route` message on
// boot) within this window after a load finishes, the WebView is blank/white —
// reload it with a cache-bust. WKWebView can serve a stale cached index.html (e.g.
// one referencing a JS bundle that 404s after a deploy), which boots to white; a
// changed URL forces a fresh fetch. Capped so a genuinely broken page can't loop.
const BOOT_TIMEOUT_MS = 9000
const MAX_BOOT_RETRIES = 4

const Shell = (): React.JSX.Element => {
  const webRef = useRef<WebView>(null)
  const insets = useSafeAreaInsets()
  const { width: windowWidth } = useWindowDimensions()
  const [bg, setBg] = useState(DEFAULT_BG)
  const [statusBarStyle, setStatusBarStyle] = useState<'light' | 'dark'>('light')
  const [index, setIndex] = useState(0)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [accent, setAccent] = useState(DEFAULT_ACTIVE_TINT)
  const [strongAccent, setStrongAccent] = useState(DEFAULT_STRONG_ACTIVE_TINT)
  const [inactive, setInactive] = useState(DEFAULT_INACTIVE_TINT)
  const [ipadChromeSurface, setIpadChromeSurface] = useState(DEFAULT_IPAD_CHROME_SURFACE)
  const [ipadTabBarWidth, setIpadTabBarWidth] = useState<number | null>(null)
  const [ipadWorkspaceName, setIpadWorkspaceName] = useState<string | null>(null)
  const [phoneHeaderSurface, setPhoneHeaderSurface] = useState(DEFAULT_PHONE_HEADER_SURFACE)
  const [phoneHeaderText, setPhoneHeaderText] = useState(DEFAULT_PHONE_HEADER_TEXT)
  const [phoneText, setPhoneText] = useState(DEFAULT_PHONE_TEXT)
  const [phoneTextMuted, setPhoneTextMuted] = useState(DEFAULT_PHONE_TEXT_MUTED)
  const [phoneOnAccent, setPhoneOnAccent] = useState(DEFAULT_PHONE_HEADER_TEXT)
  const [nativeAccount, setNativeAccount] = useState({
    avatarUrl: null as string | null,
    name: null as string | null,
    presence: 'offline' as 'away' | 'offline' | 'online',
    statusEmoji: null as string | null,
  })
  const [toolbarState, setToolbarState] = useState<ToolbarState>(DEFAULT_TOOLBAR_STATE)
  const [attentionBadges, setAttentionBadges] = useState({ channels: 0, assignedWork: 0, knowledge: 0 })
  // Bumping this remounts the WebView — used to recover Android after its render
  // process is killed (the instance is unusable until recreated).
  const [webviewKey, setWebviewKey] = useState(0)
  // Changing the loaded URL forces WKWebView to fetch a fresh index.html instead of
  // a cached (possibly stale, asset-404ing) one that boots to a blank white screen.
  const [reloadNonce, setReloadNonce] = useState(0)
  const adminBooted = useRef(false)
  const bootRetries = useRef(0)
  const bootTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentPathRef = useRef<string | null>(null)
  const pushSurfaceClientId = useRef(createNativePushSurfaceClientId())
  const nativeAppForeground = useRef(AppState.currentState === 'active')
  const nativePushRegistration = useRef<NativePushRegistration | null>(null)
  const nativePushRegistrationPromise = useRef<Promise<NativePushRegistration | null> | null>(null)

  const clearBootTimer = useCallback((): void => {
    if (bootTimer.current) {
      clearTimeout(bootTimer.current)
      bootTimer.current = null
    }
  }, [])

  const runScript = useCallback((script: string): void => {
    webRef.current?.injectJavaScript(`${script} true;`)
  }, [])

  const cachePushPath = useCallback((path: string): void => {
    runScript(nativePushPathScript(path))
  }, [runScript])
  const {
    acknowledgePushPath,
    initialPushPathResolved,
    pendingPushPath,
    replayPendingPushPath,
  } = useNativePushNavigation({
    cachePushPath,
  })
  const sourceUri = reloadNonce === 0 ? ADMIN_URL : `${ADMIN_URL}?__boot=${reloadNonce}`

  const navigateTo = useCallback((path: string): void => {
    runScript(`window.__nessieNavigate && window.__nessieNavigate(${JSON.stringify(path)});`)
  }, [runScript])

  const sendNativePushRegistration = useCallback((registration: NativePushRegistration): void => {
    runScript(
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(NATIVE_PUSH_TOKEN_EVENT)}, { detail: ${
        JSON.stringify(registration)
      } }));`,
    )
  }, [runScript])

  const publishNativePushRegistration = useCallback((registration: NativePushRegistration): void => {
    nativePushRegistration.current = registration
    const current = currentPathRef.current
    if (current && !isAuthGateRoute(current)) {
      sendNativePushRegistration(registration)
    }
  }, [sendNativePushRegistration])

  const ensureNativePushRegistration = (): void => {
    if (nativePushRegistration.current) {
      sendNativePushRegistration(nativePushRegistration.current)
      return
    }
    if (nativePushRegistrationPromise.current) {
      return
    }
    const registrationPromise = getNativePushRegistration()
    nativePushRegistrationPromise.current = registrationPromise
    void registrationPromise
      .then((registration) => {
        if (!registration) return
        publishNativePushRegistration(registration)
      })
      .catch(() => undefined)
      .finally(() => {
        if (nativePushRegistrationPromise.current === registrationPromise) {
          nativePushRegistrationPromise.current = null
        }
      })
  }

  const loadFreshWebView = useCallback((): void => {
    clearBootTimer()
    setReloadNonce((nonce) => nonce + 1)
  }, [clearBootTimer])

  // Reload the WebView fresh after a blank/failed load, capped so a persistently
  // broken page doesn't loop forever.
  const recoverBlankWebView = (): void => {
    if (adminBooted.current || bootRetries.current >= MAX_BOOT_RETRIES) return
    bootRetries.current += 1
    loadFreshWebView()
    setWebviewKey((key) => key + 1)
  }

  useEffect(() => {
    // Dev-only: expose the AppReveal debug server for on-device inspection.
    startDevInspector()
    return () => {
      if (bootTimer.current) clearTimeout(bootTimer.current)
    }
  }, [])

  useEffect(
    () => subscribeToPushTokenChanges(publishNativePushRegistration),
    [publishNativePushRegistration],
  )

  // WKWebView does not reliably emit `visibilitychange` while React Native is
  // backgrounding the app. Tell the hosted admin explicitly so it clears its
  // page-aware push target before iOS suspends the WebView.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      nativeAppForeground.current = nextState === 'active'
      runScript(nativeAppForegroundScript(nativeAppForeground.current))
      if (nativeAppForeground.current) {
        void dismissNativeNotificationCards().catch(() => undefined)
      }
    })
    return () => subscription.remove()
  }, [runScript])

  const nativeActions = createNativeWebviewActions(runScript)

  const runExternalAuth = async (authorizeUrl: string): Promise<void> => {
    const callbackUrl = await completeExternalAuth(authorizeUrl)
    if (callbackUrl) {
      const payload = JSON.stringify(callbackUrl)
      runScript(`window.__nessieExternalAuthCallback && window.__nessieExternalAuthCallback(${payload});`)
    }
  }

  const onMessage = (event: WebViewMessageEvent): void => {
    let msg: NativeShellMessage
    try {
      msg = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }
    if (msg.type === 'bg' && typeof msg.color === 'string') {
      const rgb = parseRgb(msg.color)
      if (rgb && rgb[3] !== 0) setBg(msg.color)
      return
    }
    if (msg.type === 'theme') {
      if (typeof msg.accent === 'string' && msg.accent) setAccent(msg.accent)
      if (typeof msg.accentStrong === 'string' && msg.accentStrong) setStrongAccent(msg.accentStrong)
      if (typeof msg.inactive === 'string' && msg.inactive) setInactive(msg.inactive)
      if (typeof msg.surface === 'string' && msg.surface) setIpadChromeSurface(msg.surface)
      if (typeof msg.headerSurface === 'string' && msg.headerSurface) setPhoneHeaderSurface(msg.headerSurface)
      if (typeof msg.headerText === 'string' && msg.headerText) setPhoneHeaderText(msg.headerText)
      if (typeof msg.text === 'string' && msg.text) setPhoneText(msg.text)
      if (typeof msg.textMuted === 'string' && msg.textMuted) setPhoneTextMuted(msg.textMuted)
      if (typeof msg.onAccent === 'string' && msg.onAccent) setPhoneOnAccent(msg.onAccent)
      const nextStatusBarStyle = statusBarStyleForScheme(msg.scheme)
      if (nextStatusBarStyle) setStatusBarStyle(nextStatusBarStyle)
      return
    }
    if (msg.type === 'nessie:account') {
      setNativeAccount({
        avatarUrl: typeof msg.userAvatarUrl === 'string' && msg.userAvatarUrl ? msg.userAvatarUrl : null,
        name: typeof msg.userName === 'string' && msg.userName.trim() ? msg.userName : null,
        presence: msg.userPresence === 'online' || msg.userPresence === 'away' ? msg.userPresence : 'offline',
        statusEmoji: typeof msg.userStatusEmoji === 'string' && msg.userStatusEmoji ? msg.userStatusEmoji : null,
      })
      return
    }
    if (msg.type === 'nessie:external-auth' && typeof msg.url === 'string') {
      void runExternalAuth(msg.url)
      return
    }
    if (msg.type === 'nessie:request-push-registration') {
      const path = currentPathRef.current
      if (path && !isAuthGateRoute(path)) {
        ensureNativePushRegistration()
      }
      return
    }
    if (msg.type === 'nessie:attention') {
      const channels = typeof msg.channels === 'number' && msg.channels > 0 ? Math.floor(msg.channels) : 0
      const assignedWork = typeof msg.assignedWork === 'number' && msg.assignedWork > 0
        ? Math.floor(msg.assignedWork)
        : 0
      const knowledge = typeof msg.knowledge === 'number' && msg.knowledge > 0 ? Math.floor(msg.knowledge) : 0
      setAttentionBadges({ channels, assignedWork, knowledge })
      void reconcileNativeAttentionPresentation(
        typeof msg.total === 'number' && msg.total >= 0 ? msg.total : channels + assignedWork + knowledge,
      ).catch(() => undefined)
      return
    }
    if (msg.type === 'nessie:search-overlay') {
      if (msg.active) {
        const searchIndex = TABS.findIndex((tab) => tab.key === 'search')
        if (searchIndex !== -1) setIndex(searchIndex)
      } else {
        setIndex(tabIndexForPath(currentPath ?? '/channels'))
      }
      return
    }
    if (msg.type === 'nessie:toolbar-state') {
      setToolbarState({
        canBack: Boolean(msg.canBack),
        canForward: Boolean(msg.canForward),
        recentOpen: Boolean(msg.recentOpen),
      })
      return
    }
    if (msg.type === 'nessie:workspace') {
      setIpadWorkspaceName(typeof msg.name === 'string' && msg.name.trim() ? msg.name : null)
      return
    }
    if (msg.type === 'nessie:route' && typeof msg.path === 'string') {
      // The admin only emits this once React has mounted, so it doubles as the
      // "booted" signal that defuses the blank-screen watchdog.
      adminBooted.current = true
      bootRetries.current = 0
      clearBootTimer()
      currentPathRef.current = msg.path
      void dismissNativeNotificationCards().catch(() => undefined)
      setCurrentPath(msg.path)
      const next = tabIndexForPath(msg.path)
      setIndex((current) => (current === next ? current : next))
      if (acknowledgePushPath(msg.path)) {
        runScript(nativePushPathScript(null))
      } else {
        replayPendingPushPath()
      }
      if (!isAuthGateRoute(msg.path)) {
        ensureNativePushRegistration()
      }
    }
  }

  const onIndexChange = (next: number): void => {
    setIndex(next)
    if (IS_IPAD && TABS[next]?.key === 'search') {
      nativeActions.openSearchOverlay()
      return
    }
    nativeActions.closeSearchOverlay()
    navigateTo(TABS[next].path)
  }

  // Hide the tab bar until we know the user is past the login/bootstrap gate.
  const showBar = currentPath != null && !isAuthGateRoute(currentPath) && !isFullScreenTaskRoute(currentPath)
  const showNativePhoneConversationMenu = showBar && !IS_IPAD && isNativePhoneConversationMenuRoute(currentPath)

  // The native frame owns all unsafe edges. In particular, a phone tab root is
  // not always a direct aside/main child in the web DOM, so relying on injected
  // CSS can leave its first row beneath the status bar.
  const ipadChromeTop = getIpadChromeTop(insets.top)
  const webviewInsets = getNativeWebviewFrameInsets({
    ipadChromeTop,
    isIpad: IS_IPAD,
    platform: Platform.OS,
    safeArea: insets,
    showNativePhoneMenuHeader: showNativePhoneConversationMenu,
    showTabBar: showBar,
  })
  const webviewLayerStyle = {
    ...styles.webviewLayer,
    top: webviewInsets.top,
    bottom: webviewInsets.bottom,
  }
  const ipadChromeTheme = createIpadNativeChromeTheme({
    activeTintColor: accent,
    dark: isDark(bg),
    inactiveTintColor: inactive,
    surfaceColor: ipadChromeSurface,
  })
  const navigationState = createNativeTabNavigationState(index, attentionBadges)

  return (
    <View style={[styles.fill, { backgroundColor: bg }]}>
      <StatusBar style={showNativePhoneConversationMenu ? 'light' : statusBarStyle} />

      {showBar && !IS_IPAD && !IS_ANDROID ? (
        <IphoneNativeTabBar
          activeTintColor={accent}
          inactiveTintColor={inactive}
          navigationState={navigationState}
          onIndexChange={onIndexChange}
        />
      ) : null}

      {showBar && IS_ANDROID ? (
        <AndroidTabletTabBar
          activeIndex={index}
          badgeCounts={attentionBadges}
          activeIndicatorColor={withOpacity(accent, 0.14)}
          activeTintColor={accent}
          bottom={insets.bottom + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP}
          dark={isDark(bg)}
          inactiveTintColor={inactive}
          onIndexChange={onIndexChange}
          rippleColor={withOpacity(accent, 0.18)}
        />
      ) : null}

      <View style={webviewLayerStyle}>
        {!initialPushPathResolved ? null : <WebView
          allowsBackForwardNavigationGestures
          domStorageEnabled
          injectedJavaScriptBeforeContentLoaded={nativeShellInfoScript({
            clientId: pushSurfaceClientId.current,
            formFactor: IS_IPAD ? 'ipad' : 'phone',
            pendingPushPath,
            platform: Platform.OS,
          })}
          injectedJavaScript={`${nativeShellInfoScript({
            clientId: pushSurfaceClientId.current,
            formFactor: IS_IPAD ? 'ipad' : 'phone',
            pendingPushPath,
            platform: Platform.OS,
          })}\n${INJECTED}\ntrue;`}
          key={webviewKey}
          mediaPlaybackRequiresUserAction={false}
          onContentProcessDidTerminate={() => webRef.current?.reload()}
          onError={recoverBlankWebView}
          onHttpError={recoverBlankWebView}
          onLoadEnd={() => {
            runScript(nativeAppForegroundScript(nativeAppForeground.current))
            // Page finished loading; give the admin a window to report itself
            // mounted before assuming the WebView is blank/white.
            clearBootTimer()
            if (!adminBooted.current) {
              bootTimer.current = setTimeout(recoverBlankWebView, BOOT_TIMEOUT_MS)
            }
          }}
          onLoadStart={() => {
            adminBooted.current = false
          }}
          onMessage={onMessage}
          onRenderProcessGone={() => setWebviewKey((value) => value + 1)}
          originWhitelist={['*']}
          pullToRefreshEnabled
          ref={webRef}
          sharedCookiesEnabled
          source={{ uri: sourceUri }}
          style={[styles.fill, { backgroundColor: bg }]}
        />}
      </View>

      {showNativePhoneConversationMenu ? (
        <NativePhoneConversationMenuChrome
          accentColor={accent}
          accountAvatarUrl={nativeAccount.avatarUrl}
          accountName={nativeAccount.name}
          accountPresence={nativeAccount.presence}
          bottomInset={insets.bottom}
          creationAccentColor={strongAccent}
          headerSurface={phoneHeaderSurface}
          headerText={phoneHeaderText}
          onAccentColor={phoneOnAccent}
          onAccountPress={nativeActions.toggleAccountMenu}
          onCreateAction={nativeActions.createFromPhoneMenu}
          onHistoryPress={() => nativeActions.runToolbarAction('history')}
          onWorkspacePress={() => nativeActions.toggleWorkspaceMenu(insets.left + 16)}
          safeTop={insets.top}
          sheetMutedText={phoneTextMuted}
          sheetText={phoneText}
          sheetSurface={ipadChromeSurface}
          platform={IS_ANDROID ? 'android' : 'ios'}
          workspaceName={ipadWorkspaceName}
        />
      ) : null}

      {showBar && IS_IPAD ? (
        <IpadNativeChrome
          activeIndex={index}
          account={nativeAccount}
          badgeCounts={attentionBadges}
          onIndexChange={onIndexChange}
          onTabBarWidthChange={setIpadTabBarWidth}
          onToggleAccountMenu={nativeActions.toggleAccountMenu}
          onToggleWorkspaceMenu={nativeActions.toggleWorkspaceMenu}
          onToolbarAction={nativeActions.runToolbarAction}
          insetLeft={insets.left}
          insetRight={insets.right}
          tabBarWidth={ipadTabBarWidth}
          theme={ipadChromeTheme}
          toolbarState={toolbarState}
          top={ipadChromeTop}
          windowWidth={windowWidth}
          workspaceName={ipadWorkspaceName}
        />
      ) : null}
    </View>
  )
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  webviewLayer: { position: 'absolute', right: 0, left: 0 },
})
