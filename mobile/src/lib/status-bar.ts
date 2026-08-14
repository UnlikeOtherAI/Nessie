export type NativeStatusBarStyle = 'light' | 'dark'

export const statusBarStyleForScheme = (scheme: unknown): NativeStatusBarStyle | null => {
  if (scheme === 'light') return 'dark'
  if (scheme === 'dark') return 'light'
  return null
}

// A phone tab-root header owns the status-bar backdrop, so its actual surface
// determines indicator contrast. WKWebView's computed color-scheme may be
// absent even after it has supplied the header colours.
export const statusBarStyleForNativePhoneHomeHeader = (
  hasNativePhoneHomeHeader: boolean,
  nativePhoneHomeHeaderIsDark: boolean,
  themeStyle: NativeStatusBarStyle,
): NativeStatusBarStyle => {
  if (!hasNativePhoneHomeHeader) return themeStyle
  return nativePhoneHomeHeaderIsDark ? 'light' : 'dark'
}
