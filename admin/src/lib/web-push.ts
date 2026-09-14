/**
 * Browser-side Web Push helpers. These wrap the service-worker `PushManager`
 * APIs so the settings UI can stay declarative. Everything here is best-effort:
 * callers must first check `isWebPushSupported()`.
 */

import { getBaseUrl, type ApiClient } from './api-client'

const SERVICE_WORKER_URL = '/sw.js'
let webPushOwnerGeneration = 0

/**
 * The worker receives push while the SPA is not running, so its response-token
 * fetch must retain the admin bundle's API origin in the worker script URL.
 */
export const serviceWorkerUrl = (): string => {
  const apiBaseUrl = getBaseUrl()
  return apiBaseUrl
    ? `${SERVICE_WORKER_URL}?apiBase=${encodeURIComponent(apiBaseUrl)}`
    : SERVICE_WORKER_URL
}

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
  await navigator.serviceWorker.register(serviceWorkerUrl())
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
 * Remove this browser endpoint from the ending person's tenant enrollments.
 * Do not unsubscribe the browser PushSubscription: another person must opt in
 * explicitly, but the browser can safely reuse its endpoint after that choice.
 */
export const removeBrowserPushEnrollmentsOnLogout = async (apiClient: ApiClient): Promise<void> => {
  const subscription = await getExistingSubscription()
  if (!subscription) return
  await apiClient.post('/api/push/web/logout', { endpoint: subscription.endpoint })
}

/** Tell the service worker which signed-in person may render encrypted pushes. */
export const setActiveWebPushUser = (userId: string | null): void => {
  if (!('serviceWorker' in navigator)) return
  const generation = ++webPushOwnerGeneration
  const message = { type: 'nessie.web-push-user', userId }
  navigator.serviceWorker.controller?.postMessage(message)
  void navigator.serviceWorker.ready.then((registration) => {
    if (generation !== webPushOwnerGeneration) return
    registration.active?.postMessage(message)
  }).catch(() => undefined)
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

  const applicationServerKey = urlBase64ToUint8Array(publicKey)

  // Reuse an existing subscription only if it was created with the SAME VAPID
  // key; after a key rotation a stale subscription is rejected by the push
  // service (403), so drop it and re-subscribe with the current key.
  const existing = await registration.pushManager.getSubscription()
  if (existing && !subscriptionMatchesKey(existing, applicationServerKey)) {
    await existing.unsubscribe()
  }
  const reusable = existing && subscriptionMatchesKey(existing, applicationServerKey)
    ? existing
    : null

  const subscription =
    reusable ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    }))

  return subscription.toJSON()
}

/** True when an existing subscription's server key equals the expected bytes. */
const subscriptionMatchesKey = (
  subscription: PushSubscription,
  expected: Uint8Array<ArrayBuffer>,
): boolean => {
  const current = subscription.options.applicationServerKey
  if (!current) {
    return false
  }
  const currentBytes = new Uint8Array(current)
  if (currentBytes.length !== expected.length) {
    return false
  }
  return currentBytes.every((byte, index) => byte === expected[index])
}
