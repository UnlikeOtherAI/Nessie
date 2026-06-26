/**
 * Browser-side Web Push helpers. These wrap the service-worker `PushManager`
 * APIs so the settings UI can stay declarative. Everything here is best-effort:
 * callers must first check `isWebPushSupported()`.
 */

const SERVICE_WORKER_URL = '/sw.js'

/** True when this browser exposes the full service-worker + push + permission stack. */
export const isWebPushSupported = (): boolean =>
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/**
 * Convert a base64url VAPID public key into the `Uint8Array` the
 * `PushManager.subscribe` `applicationServerKey` option expects.
 */
export const urlBase64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> => {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(normalized)
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i)
  }
  return output
}

/** The active service-worker registration, if one already exists. */
export const getRegistration = (): Promise<ServiceWorkerRegistration | undefined> =>
  navigator.serviceWorker.getRegistration()

/** Resolve to a ready registration, registering the worker first if needed. */
export const ensureRegistered = async (): Promise<ServiceWorkerRegistration> => {
  const existing = await getRegistration()
  if (existing) {
    return navigator.serviceWorker.ready
  }
  await navigator.serviceWorker.register(SERVICE_WORKER_URL)
  return navigator.serviceWorker.ready
}

/** The current browser push subscription, or null when none is active. */
export const getExistingSubscription = async (): Promise<PushSubscription | null> => {
  const registration = await getRegistration()
  if (!registration) {
    return null
  }
  return registration.pushManager.getSubscription()
}

/**
 * Subscribe this browser to push for the given VAPID public key. Prompts for
 * notification permission (must be called from a user gesture) and returns the
 * subscription as JSON, ready to POST to the API. Throws with a clear message
 * when permission is denied.
 */
export const subscribeBrowser = async (
  publicKey: string,
): Promise<PushSubscriptionJSON> => {
  const registration = await ensureRegistered()

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(
      'Notification permission was not granted. Allow notifications in your browser to enable browser notifications.',
    )
  }

  const existing = await registration.pushManager.getSubscription()
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }))

  return subscription.toJSON()
}

/**
 * Unsubscribe this browser from push. Returns the endpoint that was removed (so
 * callers can tell the API to drop it), or null when there was no subscription.
 */
export const unsubscribeBrowser = async (): Promise<string | null> => {
  const subscription = await getExistingSubscription()
  if (!subscription) {
    return null
  }
  const { endpoint } = subscription
  await subscription.unsubscribe()
  return endpoint
}
