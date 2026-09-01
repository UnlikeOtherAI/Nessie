export type NativeStatusBarStyle = 'light' | 'dark'

export const statusBarStyleForScheme = (scheme: unknown): NativeStatusBarStyle | null => {
  if (scheme === 'light') return 'dark'
  if (scheme === 'dark') return 'light'
  return null
}

// The native frame owns its status-bar backdrop. WKWebView's computed
// color-scheme may be absent even after it has supplied the backdrop colour.
export const statusBarStyleForNativeBackdrop = (
  hasNativeBackdrop: boolean,
  nativeBackdropIsDark: boolean,
  themeStyle: NativeStatusBarStyle,
): NativeStatusBarStyle => {
  if (!hasNativeBackdrop) return themeStyle
  return nativeBackdropIsDark ? 'light' : 'dark'
}
