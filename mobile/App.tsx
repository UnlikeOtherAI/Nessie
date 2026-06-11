import { useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
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

const TAB_TINT = '#7c3aed'

const Shell = (): React.JSX.Element => {
  const webRef = useRef<WebView>(null)
  const insets = useSafeAreaInsets()
  const [bg, setBg] = useState(DEFAULT_BG)
  const [index, setIndex] = useState(0)
  const capturing = useRef(false)

  useEffect(() => {
    // Dev-only: expose the AppReveal debug server for on-device inspection.
    startDevInspector()
  }, [])

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
    let msg: { type?: string; color?: string; url?: string; path?: string }
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
    if (msg.type === 'nessie:external-auth' && typeof msg.url === 'string') {
      void runExternalAuth(msg.url)
      return
    }
    if (msg.type === 'nessie:route' && typeof msg.path === 'string') {
      const next = tabIndexForPath(msg.path)
      setIndex((current) => (current === next ? current : next))
    }
  }

  const onIndexChange = (next: number): void => {
    setIndex(next)
    navigateTo(TABS[next].path)
  }

  // Inset the WebView so it fills the area *next to* the native tab bar (top on
  // iPad, bottom elsewhere), leaving the bar visible and tappable.
  const webviewLayerStyle = IS_IPAD
    ? { ...styles.webviewLayer, top: insets.top + IPAD_TAB_BAR_HEIGHT, bottom: 0 }
    : { ...styles.webviewLayer, top: 0, bottom: TAB_BAR_BASE_HEIGHT + insets.bottom }

  const navigationState = {
    index,
    routes: TABS.map((tab) => ({
      key: tab.key,
      title: tab.title,
      focusedIcon: { sfSymbol: tab.sfSymbol },
    })),
  }

  return (
    <View style={[styles.fill, { backgroundColor: bg }]}>
      <StatusBar style={isDark(bg) ? 'light' : 'dark'} />

      <View style={StyleSheet.absoluteFill}>
        <TabView
          navigationState={navigationState}
          onIndexChange={onIndexChange}
          renderScene={() => <View style={styles.scene} />}
          tabBarActiveTintColor={TAB_TINT}
          translucent
        />
      </View>

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
