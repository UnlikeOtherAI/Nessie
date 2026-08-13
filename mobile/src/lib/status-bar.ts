export type NativeStatusBarStyle = 'light' | 'dark'

export const statusBarStyleForScheme = (scheme: unknown): NativeStatusBarStyle | null => {
  if (scheme === 'light') return 'dark'
  if (scheme === 'dark') return 'light'
  return null
}

// The phone tab-root chrome occupies the status-bar backdrop with the theme's
// dark header, so its indicators stay light regardless of the page scheme.
export const statusBarStyleForNativePhoneHomeHeader = (
  hasNativePhoneHomeHeader: boolean,
  themeStyle: NativeStatusBarStyle,
): NativeStatusBarStyle => hasNativePhoneHomeHeader ? 'light' : themeStyle
