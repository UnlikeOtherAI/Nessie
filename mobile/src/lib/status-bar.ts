export type NativeStatusBarStyle = 'light' | 'dark'

export const statusBarStyleForScheme = (scheme: unknown): NativeStatusBarStyle | null => {
  if (scheme === 'light') return 'dark'
  if (scheme === 'dark') return 'light'
  return null
}
