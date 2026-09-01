import { createContext, useContext, useMemo, type PropsWithChildren } from 'react'
import { isDesktopApp } from '../lib/desktop'
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
  formFactor: ShellFormFactor
  hasNativeBridge: boolean
}

const WEB_ENVIRONMENT: ShellEnvironment = {
  runtime: 'web',
  platform: 'web',
  formFactor: 'desktop',
  hasNativeBridge: false,
}

const ShellEnvironmentContext = createContext<ShellEnvironment>(WEB_ENVIRONMENT)

// The mapping is a pure function so the probe → environment contract is unit-testable
// without mounting React (and without a real window; see test/shell-environment.test.ts).
export const deriveShellEnvironment = (input: {
  tauri: boolean
  reactNativeWebView: boolean
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
      formFactor,
      hasNativeBridge: true,
    }
  }
  if (input.tauri) {
    return { runtime: 'tauri', platform: 'desktop', formFactor: 'desktop', hasNativeBridge: true }
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
