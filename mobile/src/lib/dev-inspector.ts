// Dev-only AppReveal inspector. AppReveal is a local debugging tool that is NOT
// a committed dependency (it ships as a machine-local tarball), so the require
// is guarded by __DEV__ and wrapped in try/catch — it no-ops cleanly when the
// package isn't installed, and is dead-code-eliminated from production bundles.
// To use it: `pnpm --filter @nessie/mobile add file:<path-to>/react-native-appreveal-*.tgz`
// locally (do not commit the resulting package.json/lockfile changes).
export const startDevInspector = (): void => {
  if (!__DEV__) return
  try {
    const { AppReveal, AppRevealFetchInterceptor } = require('react-native-appreveal')
    AppReveal.start()
    AppRevealFetchInterceptor.install()
  } catch {
    // react-native-appreveal not installed — skip the debug inspector.
  }
}
