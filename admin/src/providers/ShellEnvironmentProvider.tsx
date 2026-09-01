import { createContext, useContext, useMemo, type PropsWithChildren } from 'react'
import { isDesktopApp, readDesktopPlatform, type DesktopPlatform } from '../lib/desktop'
import { isReactNativeWebView, useNativeShellInfo } from '../lib/mobile-shell'

// ShellEnvironment from docs/plans/2026-08-13-responsive-coherence.md §D: platform
// facts stay orthogonal to viewport bands. This context only wraps the existing
// probes (lib/mobile-shell.ts, lib/desktop.ts) into one value — pages keep using
// today's hooks until the Phase-4 call-site migration decides, per site, whether a
// behaviour belongs to the shell or to available width.

export type ShellRuntime = 'web' | 'tauri' | 'react-native'
export type ShellFormFactor = 'phone' | 'tablet' | 'desktop'

export type ShellEnvironment = {
  runtime: ShellRuntime
  platform: string
  // Which desktop shell is hosting the admin, or null everywhere else. The
  // window chrome (DesktopWindowFrame) and the macOS-only traffic-light spacer
  // are the only things allowed to branch on it; features never are.
  desktopPlatform: DesktopPlatform | null
  formFactor: ShellFormFactor
  hasNativeBridge: boolean
}

const WEB_ENVIRONMENT: ShellEnvironment = {
  runtime: 'web',
  platform: 'web',
  desktopPlatform: null,
  formFactor: 'desktop',
  hasNativeBridge: false,
}

const ShellEnvironmentContext = createContext<ShellEnvironment>(WEB_ENVIRONMENT)

// The mapping is a pure function so the probe → environment contract is unit-testable
// without mounting React (and without a real window; see test/shell-environment.test.ts).
export const deriveShellEnvironment = (input: {
  tauri: boolean
  reactNativeWebView: boolean
  desktopPlatform?: DesktopPlatform | null
  nativeFormFactor?: string
  nativePlatform?: string
}): ShellEnvironment => {
  if (input.reactNativeWebView) {
    // The native shell reports 'phone' or 'ipad'; anything unreported is treated as
    // tablet (the roomier layout) rather than guessed from viewport width.
    const formFactor: ShellFormFactor = input.nativeFormFactor === 'phone' ? 'phone' : 'tablet'
    return {
      runtime: 'react-native',
      platform: input.nativePlatform ?? 'unknown',
      desktopPlatform: null,
      formFactor,
      hasNativeBridge: true,
    }
  }
  if (input.tauri) {
    return {
      runtime: 'tauri',
      platform: 'desktop',
      // A desktop shell that publishes no platform is treated as macOS: that is
      // the only release that predates the published fact, and it is the only
      // one whose chrome is drawn by the OS.
      desktopPlatform: input.desktopPlatform ?? 'macos',
      formFactor: 'desktop',
      hasNativeBridge: true,
    }
  }
  return WEB_ENVIRONMENT
}

export const ShellEnvironmentProvider = ({ children }: PropsWithChildren) => {
  const info = useNativeShellInfo()
  const environment = useMemo(
    () =>
      deriveShellEnvironment({
        tauri: isDesktopApp(),
        reactNativeWebView: isReactNativeWebView(),
        desktopPlatform: readDesktopPlatform(),
        nativeFormFactor: info?.formFactor,
        nativePlatform: info?.platform,
      }),
    [info],
  )
  return (
    <ShellEnvironmentContext.Provider value={environment}>
      {children}
    </ShellEnvironmentContext.Provider>
  )
}

export const useShellEnvironment = (): ShellEnvironment => useContext(ShellEnvironmentContext)
