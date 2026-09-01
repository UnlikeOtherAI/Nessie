import { requestDesktopNotificationPermission } from './desktop-native-notification'

export const getNotificationApi = (): typeof Notification | null =>
  typeof window === 'undefined' || typeof window.Notification === 'undefined'
    ? null
    : window.Notification

/**
 * Request native notification permission. MUST be invoked synchronously from a
 * user gesture (click / tap / form submit): Safari throws "Notification
 * prompting can only be done from a user gesture" when `requestPermission()` is
 * called off-gesture (e.g. automatically on mount). No-op when notifications are
 * unsupported or permission has already been decided (granted/denied).
 */
export const requestNotificationPermission = (): void => {
  if (requestDesktopNotificationPermission()) {
    return
  }
  const api = getNotificationApi()
  if (!api || api.permission !== 'default') {
    return
  }
  try {
    // Modern browsers return a promise; older Safari can throw synchronously.
    void Promise.resolve(api.requestPermission()).catch(() => undefined)
  } catch {
    // Swallow the synchronous off-gesture throw defensively.
  }
}
