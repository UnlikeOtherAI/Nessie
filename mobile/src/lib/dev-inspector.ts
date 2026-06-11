// Dev-only AppReveal inspector. The require sits behind a __DEV__ guard so the
// debug MCP server is dead-code-eliminated from production bundles; it never
// loads or runs in release builds.
export const startDevInspector = (): void => {
  if (!__DEV__) return
  const { AppReveal, AppRevealFetchInterceptor } = require('react-native-appreveal')
  AppReveal.start()
  AppRevealFetchInterceptor.install()
}
