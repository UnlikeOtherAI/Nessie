import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppState,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as WebBrowser from 'expo-web-browser'
import TabView from 'react-native-bottom-tabs'
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
import { TABS, tabIndexForPath } from './src/lib/tabs'
import { DEFAULT_BG, INJECTED, isDark, parseRgb } from './src/lib/webview-inject'
import { statusBarStyleForScheme } from './src/lib/status-bar'
import {
  createIpadNativeChromeTheme,
  getIpadChromeTop,
  getIpadToolbarLeft,
  IPAD_NATIVE_CHROME_HEIGHT,
  withOpacity,
} from './src/lib/ipad-native-chrome'
import {
  ANDROID_TABLET_TAB_BAR_BOTTOM_GAP,
} from './src/lib/android-tablet-dock'
import { AndroidTabletTabBar } from './src/components/AndroidTabletTabBar'
import {
  DEFAULT_TOOLBAR_STATE,
  IpadNativeToolbar,
  type ToolbarAction,
  type ToolbarState,
} from './src/components/IpadNativeToolbar'
import { IpadNativeTabBar } from './src/components/IpadNativeTabBar'
// Deep-link callback the OS browser redirects to after external sign-in. Must
// match the admin's externalAuthRedirectUri and the API's allow-listed URL.
const AUTH_CALLBACK_URL = 'nessie://auth/callback'
// The native tab bar sits beside the WebView; reserve room for it so the
// WebView's own content (e.g. the channel composer) is never hidden. iOS 26 on
// iPad puts the tab bar at the TOP; iPhone and Android keep it at the bottom.
const IPHONE_TAB_BAR_HEIGHT = 49
const IS_IPAD = Platform.OS === 'ios' && Platform.isPad
const IS_ANDROID = Platform.OS === 'android'
const NATIVE_PUSH_TOKEN_EVENT = 'nessie:native-push-token'
const DEFAULT_ACTIVE_TINT = '#7c3aed'
const DEFAULT_INACTIVE_TINT = '#8a8f98'
const DEFAULT_IPAD_CHROME_SURFACE = '#222629'

// If the admin never reports itself mounted (it posts a `nessie:route` message on
// boot) within this window after a load finishes, the WebView is blank/white —
// reload it with a cache-bust. WKWebView can serve a stale cached index.html (e.g.
// one referencing a JS bundle that 404s after a deploy), which boots to white; a
// changed URL forces a fresh fetch. Capped so a genuinely broken page can't loop.
const BOOT_TIMEOUT_MS = 9000
const MAX_BOOT_RETRIES = 4

// The tab bar only makes sense once the user is inside the workspace; hide it on
// the login / bootstrap screens (reported via nessie:route).
const isAuthGateRoute = (path: string): boolean =>
  path.startsWith('/login') || path.startsWith('/bootstrap')

const isFullScreenTaskRoute = (path: string): boolean => path === '/channels/new'

const Shell = (): React.JSX.Element => {
  const webRef = useRef<WebView>(null)
  const insets = useSafeAreaInsets()
  const { width: windowWidth } = useWindowDimensions()
  const [bg, setBg] = useState(DEFAULT_BG)
  const [statusBarStyle, setStatusBarStyle] = useState<'light' | 'dark'>('light')
  const [index, setIndex] = useState(0)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [accent, setAccent] = useState(DEFAULT_ACTIVE_TINT)
  const [inactive, setInactive] = useState(DEFAULT_INACTIVE_TINT)
  const [ipadChromeSurface, setIpadChromeSurface] = useState(DEFAULT_IPAD_CHROME_SURFACE)
  const [ipadTabBarWidth, setIpadTabBarWidth] = useState<number | null>(null)
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

  const openSearchOverlay = (): void => {
    runScript('window.__nessieOpenSearchOverlay && window.__nessieOpenSearchOverlay();')
  }

  const closeSearchOverlay = (): void => {
    runScript('window.__nessieCloseSearchOverlay && window.__nessieCloseSearchOverlay();')
  }

  const runToolbarAction = (action: ToolbarAction): void => {
    runScript(
      `window.__nessieToolbarAction && window.__nessieToolbarAction(${JSON.stringify(action)});`,
    )
  }

  // Google blocks OAuth inside embedded webviews, so the admin hands SSO off to
  // us: open the authorize URL in the OS browser (ASWebAuthenticationSession),
  // then deliver the deep-link callback back into the webview to finish.
  const runExternalAuth = async (authorizeUrl: string): Promise<void> => {
    const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, AUTH_CALLBACK_URL)
    if (result.type === 'success' && result.url) {
      const payload = JSON.stringify(result.url)
      runScript(`window.__nessieExternalAuthCallback && window.__nessieExternalAuthCallback(${payload});`)
    }
  }

  const onMessage = (event: WebViewMessageEvent): void => {
    let msg: {
      type?: string
      color?: string
      url?: string
      path?: string
      accent?: string
      inactive?: string
      surface?: string
      scheme?: string
      active?: boolean
      canBack?: boolean
      canForward?: boolean
      recentOpen?: boolean
      channels?: number
      assignedWork?: number
      knowledge?: number
      total?: number
    }
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
      if (typeof msg.inactive === 'string' && msg.inactive) setInactive(msg.inactive)
      if (typeof msg.surface === 'string' && msg.surface) setIpadChromeSurface(msg.surface)
      const nextStatusBarStyle = statusBarStyleForScheme(msg.scheme)
      if (nextStatusBarStyle) setStatusBarStyle(nextStatusBarStyle)
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
      openSearchOverlay()
      return
    }
    closeSearchOverlay()
    navigateTo(TABS[next].path)
  }

  // Hide the tab bar until we know the user is past the login/bootstrap gate.
  const showBar = currentPath != null && !isAuthGateRoute(currentPath) && !isFullScreenTaskRoute(currentPath)

  // Inset the WebView for the status bar (Android draws edge-to-edge) and for the
  // native tab bar when it's shown (top on iPad, bottom elsewhere). Android's
  // floating dock overlays the WebView rather than shortening it: injected CSS
  // reserves interaction space while the page background and column dividers
  // continue beneath the dock. The iPhone WebView stays edge to edge; INJECTED
  // gives its page content the top safe-area padding.
  const ipadChromeTop = getIpadChromeTop(insets.top)
  const topInset = IS_IPAD && showBar
    ? ipadChromeTop + IPAD_NATIVE_CHROME_HEIGHT
    : IS_ANDROID
      ? insets.top
      : 0
  const bottomInset =
    IS_ANDROID
      ? insets.bottom
      : showBar && !IS_IPAD
        ? IPHONE_TAB_BAR_HEIGHT + insets.bottom
        : 0
  const webviewLayerStyle = { ...styles.webviewLayer, top: topInset, bottom: bottomInset }
  const ipadChromeTheme = createIpadNativeChromeTheme({
    activeTintColor: accent,
    dark: isDark(bg),
    inactiveTintColor: inactive,
    surfaceColor: ipadChromeSurface,
  })
  const ipadToolbarLeft = ipadTabBarWidth === null
    ? null
    : getIpadToolbarLeft(windowWidth, ipadTabBarWidth, insets.left)

  const navigationState = {
    index,
    routes: TABS.map((tab) => ({
      key: tab.key,
      title: tab.title,
      role: tab.role,
      badge: (() => {
        const value = tab.key === 'channels'
          ? attentionBadges.channels
          : tab.key === 'projects'
            ? attentionBadges.assignedWork
            : tab.key === 'knowledge'
              ? attentionBadges.knowledge
              : 0
        return value > 0 ? String(value) : undefined
      })(),
    })),
  }

  return (
    <View style={[styles.fill, { backgroundColor: bg }]}>
      <StatusBar style={statusBarStyle} />

      {showBar && !IS_IPAD && !IS_ANDROID ? (
        <View style={StyleSheet.absoluteFill}>
          <TabView
            getIcon={({ route }) => {
              const tab = TABS.find((item) => item.key === route.key)
              if (!tab) return undefined
              return { sfSymbol: tab.sfSymbol }
            }}
            navigationState={navigationState}
            onIndexChange={onIndexChange}
            renderScene={() => <View style={styles.scene} />}
            tabBarActiveTintColor={accent}
            tabBarInactiveTintColor={inactive}
            translucent
          />
        </View>
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

      {showBar && IS_IPAD ? (
        <IpadNativeTabBar
          activeIndex={index}
          badgeCounts={attentionBadges}
          onIndexChange={onIndexChange}
          onWidthChange={setIpadTabBarWidth}
          theme={ipadChromeTheme}
          top={ipadChromeTop}
        />
      ) : null}

      {showBar && IS_IPAD && ipadToolbarLeft !== null ? (
        <IpadNativeToolbar
          canBack={toolbarState.canBack}
          canForward={toolbarState.canForward}
          left={ipadToolbarLeft}
          onAction={runToolbarAction}
          recentOpen={toolbarState.recentOpen}
          theme={ipadChromeTheme}
          top={ipadChromeTop}
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
  scene: { flex: 1 },
  webviewLayer: { position: 'absolute', right: 0, left: 0 },
})
