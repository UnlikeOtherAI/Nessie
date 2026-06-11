import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import WebView from 'react-native-webview'

import { ADMIN_URL } from './src/config'
import { startDevInspector } from './src/lib/dev-inspector'

export default function App(): React.JSX.Element {
  const webRef = useRef<WebView>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Dev-only: expose the AppReveal debug server for on-device inspection.
    startDevInspector()
  }, [])

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        <WebView
          ref={webRef}
          source={{ uri: ADMIN_URL }}
          style={styles.web}
          originWhitelist={['*']}
          allowsBackForwardNavigationGestures
          sharedCookiesEnabled
          domStorageEnabled
          pullToRefreshEnabled
          mediaPlaybackRequiresUserAction={false}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
        />
        {loading ? (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator size="large" color="#2563eb" />
          </View>
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  safe: { backgroundColor: '#ffffff', flex: 1 },
  web: { backgroundColor: '#ffffff', flex: 1 },
})
