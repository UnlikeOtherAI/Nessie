/** Event emitted by the React Native shell when its host app becomes active. */
export const NATIVE_APP_FOREGROUND_EVENT = 'nessie:native-app-foreground'

/**
 * WKWebView does not reliably emit a visible document event while backgrounded,
 * so native callers carry an explicit boolean instead.
 */
export const isNativeAppForegroundEvent = (event: Event): boolean =>
  event.type === NATIVE_APP_FOREGROUND_EVENT
  && (event as Event & { detail?: unknown }).detail === true
