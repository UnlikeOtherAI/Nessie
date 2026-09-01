import type { SessionClientType } from '@nessie/schemas'
import { isDesktopApp } from './desktop'
import { isReactNativeWebView } from './mobile-shell'

type NativeShellWindow = Window & {
  __nessieNativeShell?: { platform?: string }
}

/** The native frame identifies itself; browser sessions use their user agent. */
export const getSessionClientType = (): SessionClientType | null => {
  if (isDesktopApp()) return 'native-desktop'
  if (!isReactNativeWebView()) return null

  const platform = (window as NativeShellWindow).__nessieNativeShell?.platform
  if (platform === 'ios') return 'native-ios'
  if (platform === 'android') return 'native-android'
  return 'native-mobile'
}
