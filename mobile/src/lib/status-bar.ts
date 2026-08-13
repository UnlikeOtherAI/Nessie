export type NativeStatusBarStyle = 'light' | 'dark'

export const statusBarStyleForScheme = (scheme: unknown): NativeStatusBarStyle | null => {
  if (scheme === 'light') return 'dark'
  if (scheme === 'dark') return 'light'
  return null
}

// A phone tab-root header owns the status-bar backdrop. Override the page
// scheme only when that header is actually dark.
export const statusBarStyleForNativePhoneHomeHeader = (
  hasDarkNativePhoneHomeHeader: boolean,
  themeStyle: NativeStatusBarStyle,
): NativeStatusBarStyle => hasDarkNativePhoneHomeHeader ? 'light' : themeStyle
