import { requireOptionalNativeModule } from 'expo-modules-core'

/**
 * Full-screen Android: the status bar and the system taskbar hidden, the app
 * drawing over the whole screen.
 *
 * Android-only. `requireOptionalNativeModule` keeps "this build does not have
 * it" a readable state — on iOS, and in an installed Android build that
 * predates the module — so the shell degrades to the ordinary edge-to-edge
 * window instead of throwing.
 */

type NessieImmersiveNativeModule = {
  isSupported: () => boolean
  setFullScreen: (enabled: boolean) => Promise<void>
}

const nativeModule = requireOptionalNativeModule<NessieImmersiveNativeModule>('NessieImmersive')

export const isNativeFullScreenAvailable = (): boolean => nativeModule?.isSupported() === true

/**
 * Ask Android to hide (or restore) the system bars. Failures are swallowed on
 * purpose: the window is a system resource the app does not own, and a refused
 * request is a slightly smaller screen, never a broken shell.
 */
export const setNativeFullScreen = (enabled: boolean): void => {
  void nativeModule?.setFullScreen(enabled).catch(() => undefined)
}
