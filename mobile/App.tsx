import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as WebBrowser from 'expo-web-browser'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'

import { ADMIN_URL } from './src/config'
import { startDevInspector } from './src/lib/dev-inspector'

// Deep-link callback the OS browser redirects to after external sign-in. Must
// match the admin's externalAuthRedirectUri and the API's allow-listed URL.
const AUTH_CALLBACK_URL = 'nessie://auth/callback'

// Injected into the admin page. The WebView fills the whole screen, so the
// admin's full-height columns (rail/nav/page) already run edge to edge with no
// seam. This (1) enables CSS safe-area insets via viewport-fit=cover, (2) pads
// the column *content* down past the status bar / home indicator while the
// column backgrounds still reach the screen edges, and (3) reports the document
// background so the native view behind the WebView matches during load/overscroll.
const INJECTED = `
(function () {
  var vp = document.querySelector('meta[name=viewport]');
  if (vp && vp.content.indexOf('viewport-fit') === -1) { vp.content += ', viewport-fit=cover'; }
  else if (!vp) {
    vp = document.createElement('meta');
    vp.name = 'viewport';
    vp.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    (document.head || document.documentElement).appendChild(vp);
  }

  var styleId = 'nessie-mobile-safe-area';
  if (!document.getElementById(styleId)) {
    var st = document.createElement('style');
    st.id = styleId;
    st.textContent =
      '.admin-shell > aside, .admin-shell > main {' +
      '  padding-top: env(safe-area-inset-top);' +
      '  padding-bottom: env(safe-area-inset-bottom);' +
      '}';
    (document.head || document.documentElement).appendChild(st);
  }

  function bgOf(el) { try { return getComputedStyle(el).backgroundColor } catch (e) { return '' } }
  function transparent(c) {
    if (!c || c === 'transparent') return true;
    var n = c.replace(/[^0-9.,]/g, '').split(',');
    return n.length >= 4 && parseFloat(n[3]) === 0;
  }
  function pick() {
    var els = [document.body, document.documentElement, document.getElementById('root')];
    for (var i = 0; i < els.length; i++) {
      if (els[i]) { var c = bgOf(els[i]); if (!transparent(c)) return c; }
    }
    return '';
  }
  function post() {
    var c = pick();
    if (c) { try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'bg', color: c })) } catch (e) {} }
  }
  post();
  new MutationObserver(post).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme', 'class', 'style'],
  });
  if (document.body) {
    new MutationObserver(post).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  window.addEventListener('load', post);
  true;
})();
`

const DEFAULT_BG = '#1a1d21'

const parseRgb = (c: string): [number, number, number, number] | null => {
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const p = m[1].split(',').map((s) => parseFloat(s.trim()))
  if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
}

const isDark = (c: string): boolean => {
  const rgb = parseRgb(c)
  if (!rgb) return true
  const [r, g, b] = rgb
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

export default function App(): React.JSX.Element {
  const webRef = useRef<WebView>(null)
  const [bg, setBg] = useState(DEFAULT_BG)

  useEffect(() => {
    // Dev-only: expose the AppReveal debug server for on-device inspection.
    startDevInspector()
  }, [])

  // Google blocks OAuth inside embedded webviews, so the admin hands SSO off to
  // us: open the authorize URL in the OS browser (ASWebAuthenticationSession),
  // then deliver the deep-link callback back into the webview to finish.
  const runExternalAuth = async (authorizeUrl: string): Promise<void> => {
    const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, AUTH_CALLBACK_URL)
    if (result.type === 'success' && result.url) {
      const payload = JSON.stringify(result.url)
      webRef.current?.injectJavaScript(
        `window.__nessieExternalAuthCallback && window.__nessieExternalAuthCallback(${payload}); true;`,
      )
    }
  }

  const onMessage = (event: WebViewMessageEvent): void => {
    let msg: { type?: string; color?: string; url?: string }
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
    }
  }

  return (
    <View style={[styles.fill, { backgroundColor: bg }]}>
      <StatusBar style={isDark(bg) ? 'light' : 'dark'} />
      <WebView
        ref={webRef}
        source={{ uri: ADMIN_URL }}
        style={[styles.fill, { backgroundColor: bg }]}
        originWhitelist={['*']}
        allowsBackForwardNavigationGestures
        sharedCookiesEnabled
        domStorageEnabled
        pullToRefreshEnabled
        mediaPlaybackRequiresUserAction={false}
        injectedJavaScript={INJECTED}
        onMessage={onMessage}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
})
