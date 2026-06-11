import { useEffect, useRef, useState } from 'react'
import { type ImageSourcePropType, Platform, StyleSheet, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { StatusBar } from 'expo-status-bar'
import * as WebBrowser from 'expo-web-browser'
import TabView from 'react-native-bottom-tabs'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { captureScreen } from 'react-native-view-shot'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'

import { ADMIN_URL } from './src/config'
import { startDevInspector } from './src/lib/dev-inspector'
import { TABS, tabIndexForPath } from './src/lib/tabs'
import { useShake } from './src/lib/use-shake'
import { DEFAULT_BG, INJECTED, isDark, parseRgb } from './src/lib/webview-inject'

// Deep-link callback the OS browser redirects to after external sign-in. Must
// match the admin's externalAuthRedirectUri and the API's allow-listed URL.
const AUTH_CALLBACK_URL = 'nessie://auth/callback'

// The native tab bar sits beside the WebView; reserve room for it so the
// WebView's own content (e.g. the channel composer) is never hidden. iOS 26 on
// iPad puts the tab bar at the TOP; iPhone and Android keep it at the bottom.
const TAB_BAR_BASE_HEIGHT = Platform.OS === 'ios' ? 49 : 64
const IPAD_TAB_BAR_HEIGHT = 50
const IS_IPAD = Platform.OS === 'ios' && Platform.isPad
const IS_ANDROID = Platform.OS === 'android'

const DEFAULT_ACTIVE_TINT = '#7c3aed'
const DEFAULT_INACTIVE_TINT = '#8a8f98'
const ANDROID_ICON_SIZE = 26

// The tab bar only makes sense once the user is inside the workspace; hide it on
// the login / bootstrap screens (reported via nessie:route).
const isAuthGateRoute = (path: string): boolean =>
  path.startsWith('/login') || path.startsWith('/bootstrap')

type AndroidIconSet = { active: Record<string, ImageSourcePropType>; inactive: Record<string, ImageSourcePropType> }

const Shell = (): React.JSX.Element => {
  const webRef = useRef<WebView>(null)
  const insets = useSafeAreaInsets()
  const [bg, setBg] = useState(DEFAULT_BG)
  const [index, setIndex] = useState(0)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [accent, setAccent] = useState(DEFAULT_ACTIVE_TINT)
  const [inactive, setInactive] = useState(DEFAULT_INACTIVE_TINT)
  const [androidIcons, setAndroidIcons] = useState<AndroidIconSet | null>(null)
  const capturing = useRef(false)

  useEffect(() => {
    // Dev-only: expose the AppReveal debug server for on-device inspection.
    startDevInspector()
  }, [])

  // Android tab icons are Material glyphs rendered to image sources (SF Symbols
  // are iOS-only); re-render them whenever the theme tints change.
  useEffect(() => {
    if (!IS_ANDROID) return undefined
    let cancelled = false
    const resolve = async (): Promise<void> => {
      const activeIcons: Record<string, ImageSourcePropType> = {}
      const inactiveIcons: Record<string, ImageSourcePropType> = {}
      await Promise.all(
        TABS.map(async (tab) => {
          const [activeIcon, inactiveIcon] = await Promise.all([
            MaterialIcons.getImageSource(tab.materialIcon, ANDROID_ICON_SIZE, accent),
            MaterialIcons.getImageSource(tab.materialIcon, ANDROID_ICON_SIZE, inactive),
          ])
          if (activeIcon) activeIcons[tab.key] = activeIcon
          if (inactiveIcon) inactiveIcons[tab.key] = inactiveIcon
        }),
      )
      if (!cancelled) setAndroidIcons({ active: activeIcons, inactive: inactiveIcons })
    }
    void resolve()
    return () => {
      cancelled = true
    }
  }, [accent, inactive])

  const runScript = (script: string): void => {
    webRef.current?.injectJavaScript(`${script} true;`)
  }

  const navigateTo = (path: string): void => {
    runScript(`window.__nessieNavigate && window.__nessieNavigate(${JSON.stringify(path)});`)
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

  // Shake to file feedback: capture the current screen and hand it to the admin
  // feedback composer, which previews and attaches it.
  const onShake = async (): Promise<void> => {
    if (capturing.current) return
    capturing.current = true
    try {
      const uri = await captureScreen({ format: 'png', quality: 0.9, result: 'data-uri' })
      const payload = JSON.stringify(uri)
      runScript(
        `window.__nessieNavigate && window.__nessieNavigate('/feedback');` +
          `window.__nessieShakeScreenshot && window.__nessieShakeScreenshot(${payload});`,
      )
    } catch {
      // Capture can fail transiently (e.g. mid-transition); ignore and let the
      // next shake try again.
    } finally {
      capturing.current = false
    }
  }
  useShake(() => {
    void onShake()
  })

  const onMessage = (event: WebViewMessageEvent): void => {
    let msg: { type?: string; color?: string; url?: string; path?: string; accent?: string; inactive?: string }
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
    if (msg.type === 'nessie:route' && typeof msg.path === 'string') {
      setCurrentPath(msg.path)
      const next = tabIndexForPath(msg.path)
      setIndex((current) => (current === next ? current : next))
    }
  }

  const onIndexChange = (next: number): void => {
    setIndex(next)
    navigateTo(TABS[next].path)
  }

  // Hide the tab bar until we know the user is past the login/bootstrap gate.
  const showBar = currentPath != null && !isAuthGateRoute(currentPath)

  // Inset the WebView for the status bar (Android draws edge-to-edge) and for the
  // native tab bar when it's shown (top on iPad, bottom elsewhere).
  const topInset = IS_IPAD && showBar ? insets.top + IPAD_TAB_BAR_HEIGHT : IS_ANDROID ? insets.top : 0
  const bottomInset =
    showBar && !IS_IPAD ? TAB_BAR_BASE_HEIGHT + insets.bottom : IS_ANDROID ? insets.bottom : 0
  const webviewLayerStyle = { ...styles.webviewLayer, top: topInset, bottom: bottomInset }

  const navigationState = {
    index,
    routes: TABS.map((tab) => ({ key: tab.key, title: tab.title, role: tab.role })),
  }

  return (
    <View style={[styles.fill, { backgroundColor: bg }]}>
      <StatusBar style={isDark(bg) ? 'light' : 'dark'} />

      {showBar && (
        <View style={StyleSheet.absoluteFill}>
          <TabView
            getIcon={({ route, focused }) => {
              const tab = TABS.find((item) => item.key === route.key)
              if (!tab) return undefined
              if (IS_ANDROID) {
                if (!androidIcons) return undefined
                return focused ? androidIcons.active[tab.key] : androidIcons.inactive[tab.key]
              }
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
      )}

      <View style={webviewLayerStyle}>
        <WebView
          allowsBackForwardNavigationGestures
          domStorageEnabled
          injectedJavaScript={INJECTED}
          mediaPlaybackRequiresUserAction={false}
          onMessage={onMessage}
          originWhitelist={['*']}
          pullToRefreshEnabled
          ref={webRef}
          sharedCookiesEnabled
          source={{ uri: ADMIN_URL }}
          style={[styles.fill, { backgroundColor: bg }]}
        />
      </View>
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
