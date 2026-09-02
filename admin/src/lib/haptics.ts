import { isReactNativeWebView } from './mobile-shell'

export type HapticKind = 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error'

type HapticWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
}

// The web Vibration API cannot express expo-haptics' finer impact/selection
// families meaningfully, so the browser fallback is reserved for the two
// outcome kinds a short buzz pattern still reads as feedback for.
const WEB_VIBRATE_PATTERN: Partial<Record<HapticKind, number[]>> = {
  error: [120, 80, 120, 80, 120],
  warning: [180, 120, 180],
}

// Posts the shared `nessie:haptic` bridge message inside the native shell
// (mirrors `mobile/src/lib/haptics.ts`, which maps it onto expo-haptics'
// impactAsync/selectionAsync/notificationAsync). Outside the shell it falls
// back to the browser's own coarse Vibration API for `warning`/`error` only;
// every other kind is silent on the web since there is nothing meaningful to
// render there.
export const haptic = (kind: HapticKind): void => {
  if (isReactNativeWebView()) {
    (window as HapticWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({ type: 'nessie:haptic', haptic: kind }),
    )
    return
  }
  const pattern = WEB_VIBRATE_PATTERN[kind]
  if (pattern) navigator.vibrate?.(pattern)
}

// Cancels a web vibration a caller started (e.g. an unanswered ring). Native
// haptics are one-shot and need no stop call.
export const stopHaptic = (): void => {
  if (isReactNativeWebView()) return
  navigator.vibrate?.(0)
}
