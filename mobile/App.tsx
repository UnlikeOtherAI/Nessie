import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Platform,
  StyleSheet,
  View,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as WebBrowser from 'expo-web-browser'
import TabView from 'react-native-bottom-tabs'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'

import { ADMIN_URL } from './src/config'
import { startDevInspector } from './src/lib/dev-inspector'
import {
  getNativePushRegistration,
  subscribeToPushTokenChanges,
  subscribeToPushNavigation,
  type NativePushRegistration,
} from './src/lib/push-notifications'
import { TABS, tabIndexForPath } from './src/lib/tabs'
import { DEFAULT_BG, INJECTED, isDark, parseRgb } from './src/lib/webview-inject'
import {
  ANDROID_TABLET_TAB_BAR_BOTTOM_GAP,
  ANDROID_TABLET_TAB_BAR_CONTENT_INSET,
  AndroidTabletTabBar,
} from './src/components/AndroidTabletTabBar'
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
const IPAD_TAB_BAR_HEIGHT = 50
const IS_IPAD = Platform.OS === 'ios' && Platform.isPad
const IS_ANDROID = Platform.OS === 'android'
const NATIVE_PUSH_TOKEN_EVENT = 'nessie:native-push-token'
const NATIVE_SHELL_INFO_SCRIPT = `
window.__nessieNativeShell = { platform: ${JSON.stringify(Platform.OS)}, formFactor: ${
  IS_IPAD ? "'ipad'" : "'phone'"
} };
try { window.dispatchEvent(new Event('nessie:native-shell-info')); } catch (e) {}
true;
`

const DEFAULT_ACTIVE_TINT = '#7c3aed'
const DEFAULT_INACTIVE_TINT = '#8a8f98'
const withOpacity = (color: string, opacity: number): string => {
  const rgb = parseRgb(color)
  if (rgb) {
    const [red, green, blue] = rgb
    return `rgba(${red}, ${green}, ${blue}, ${opacity})`
  }

  const hex = color.replace(/^#/, '')
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const alpha = Math.round(opacity * 255)
      .toString(16)
      .padStart(2, '0')
    return `#${hex}${alpha}`
  }

  return color
}

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

const Shell = (): React.JSX.Element => {
  const webRef = useRef<WebView>(null)
  const insets = useSafeAreaInsets()
  const [bg, setBg] = useState(DEFAULT_BG)
  const [index, setIndex] = useState(0)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [accent, setAccent] = useState(DEFAULT_ACTIVE_TINT)
  const [inactive, setInactive] = useState(DEFAULT_INACTIVE_TINT)
  const [toolbarState, setToolbarState] = useState<ToolbarState>(DEFAULT_TOOLBAR_STATE)
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
  const pendingPushPath = useRef<string | null>(null)
  const nativePushRegistration = useRef<NativePushRegistration | null>(null)
  const nativePushRegistrationPromise = useRef<Promise<NativePushRegistration | null> | null>(null)

  const sourceUri =
    reloadNonce === 0
      ? ADMIN_URL
      : `${ADMIN_URL}${ADMIN_URL.includes('?') ? '&' : '?'}__boot=${reloadNonce}`

  const clearBootTimer = useCallback((): void => {
    if (bootTimer.current) {
      clearTimeout(bootTimer.current)
      bootTimer.current = null
    }
  }, [])

  const runScript = useCallback((script: string): void => {
    webRef.current?.injectJavaScript(`${script} true;`)
  }, [])

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
    () =>
      subscribeToPushNavigation((path) => {
        pendingPushPath.current = path
        const current = currentPathRef.current
        if (current && !isAuthGateRoute(current)) {
          pendingPushPath.current = null
          navigateTo(path)
        }
      }),
    [navigateTo],
  )

  useEffect(
    () => subscribeToPushTokenChanges(publishNativePushRegistration),
    [publishNativePushRegistration],
  )

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
      active?: boolean
      canBack?: boolean
      canForward?: boolean
      recentOpen?: boolean
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
      setCurrentPath(msg.path)
      const next = tabIndexForPath(msg.path)
      setIndex((current) => (current === next ? current : next))
      if (!isAuthGateRoute(msg.path)) {
        ensureNativePushRegistration()
        const pendingPath = pendingPushPath.current
        if (pendingPath) {
          pendingPushPath.current = null
          navigateTo(pendingPath)
        }
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
  const showBar = currentPath != null && !isAuthGateRoute(currentPath)

  // Inset the WebView for the status bar (Android draws edge-to-edge) and for the
  // native tab bar when it's shown (top on iPad, bottom elsewhere). The iPhone
  // WebView stays edge to edge; INJECTED gives its page content the top safe-area
  // padding so each column background still reaches behind the status bar.
  const topInset = IS_IPAD && showBar ? insets.top + IPAD_TAB_BAR_HEIGHT : IS_ANDROID ? insets.top : 0
  const bottomInset =
    showBar && !IS_IPAD
      ? (IS_ANDROID ? ANDROID_TABLET_TAB_BAR_CONTENT_INSET : IPHONE_TAB_BAR_HEIGHT) + insets.bottom
      : IS_ANDROID
        ? insets.bottom
        : 0
  const webviewLayerStyle = { ...styles.webviewLayer, top: topInset, bottom: bottomInset }

  const navigationState = {
    index,
    routes: TABS.map((tab) => ({ key: tab.key, title: tab.title, role: tab.role })),
  }

  return (
    <View style={[styles.fill, { backgroundColor: bg }]}>
      <StatusBar style={isDark(bg) ? 'light' : 'dark'} />

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
          activeIndicatorColor={withOpacity(accent, 0.14)}
          activeTintColor={accent}
          bottom={insets.bottom + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP}
          dark={isDark(bg)}
          inactiveTintColor={inactive}
          onIndexChange={onIndexChange}
          rippleColor={withOpacity(accent, 0.18)}
          separatorColor={withOpacity(isDark(bg) ? '#ffffff' : '#49341f', 0.18)}
        />
      ) : null}

      <View style={webviewLayerStyle}>
        <WebView
          allowsBackForwardNavigationGestures
          domStorageEnabled
          injectedJavaScriptBeforeContentLoaded={NATIVE_SHELL_INFO_SCRIPT}
          injectedJavaScript={`${NATIVE_SHELL_INFO_SCRIPT}\n${INJECTED}`}
          key={webviewKey}
          mediaPlaybackRequiresUserAction={false}
          onContentProcessDidTerminate={() => webRef.current?.reload()}
          onError={recoverBlankWebView}
          onHttpError={recoverBlankWebView}
          onLoadEnd={() => {
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
        />
      </View>

      {showBar && IS_IPAD ? (
        <IpadNativeTabBar
          activeIndex={index}
          activeTintColor={accent}
          dark={isDark(bg)}
          inactiveTintColor={inactive}
          onIndexChange={onIndexChange}
          top={insets.top + 4}
        />
      ) : null}

      {showBar && IS_IPAD ? (
        <IpadNativeToolbar
          canBack={toolbarState.canBack}
          canForward={toolbarState.canForward}
          onAction={runToolbarAction}
          recentOpen={toolbarState.recentOpen}
          top={insets.top + 6}
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
