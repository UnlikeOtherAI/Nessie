const AUTH_CALLBACK_URL = 'nessie://auth/callback'
const CANCEL_CALLBACK_URL = `${AUTH_CALLBACK_URL}?error=access_denied`
const ERROR_CALLBACK_URL = `${AUTH_CALLBACK_URL}?error=native_auth_error`

export type ExternalAuthTerminalResult =
  | { callbackUrl: string; kind: 'callback' }
  | { callbackUrl: string; kind: 'cancelled' }
  | { callbackUrl: string; kind: 'error' }

export const mapExternalAuthSessionResult = (
  result: { type: string; url?: string },
  state?: string,
): ExternalAuthTerminalResult => {
  if (result.type === 'success' && result.url) {
    return { callbackUrl: result.url, kind: 'callback' }
  }
  if (result.type === 'cancel' || result.type === 'dismiss') {
    const suffix = state ? `&state=${encodeURIComponent(state)}` : ''
    return { callbackUrl: `${CANCEL_CALLBACK_URL}${suffix}`, kind: 'cancelled' }
  }
  const suffix = state ? `&state=${encodeURIComponent(state)}` : ''
  return { callbackUrl: `${ERROR_CALLBACK_URL}${suffix}`, kind: 'error' }
}

export type NativeExternalAuthDelivery = { id: number; url: string }

export type NativeExternalAuthDeliveryQueue = {
  acknowledge: (id: number) => void
  enqueue: (url: string) => NativeExternalAuthDelivery
  head: () => NativeExternalAuthDelivery | null
}

/** Process-lifetime native queue: WebView reloads cannot erase terminal results. */
export const createNativeExternalAuthDeliveryQueue = (
  limit = 4,
): NativeExternalAuthDeliveryQueue => {
  const queued: NativeExternalAuthDelivery[] = []
  let nextId = 1
  return {
    acknowledge: (id) => {
      const index = queued.findIndex((entry) => entry.id === id)
      if (index >= 0) queued.splice(index, 1)
    },
    enqueue: (url) => {
      const entry = { id: nextId, url }
      nextId += 1
      if (queued.length >= limit) queued.shift()
      queued.push(entry)
      return entry
    },
    head: () => queued[0] ?? null,
  }
}

/** Invoke the SPA handler directly; retain natively when it is not installed. */
export const nativeExternalAuthDeliveryScript = (
  delivery: NativeExternalAuthDelivery,
): string => {
  const id = JSON.stringify(delivery.id)
  const url = JSON.stringify(delivery.url)
  return `(function(){var w=window;if(typeof w.__nessieExternalAuthCallback!=='function')return;`
    + `w.__nessieExternalAuthCallback(${url});`
    + `try{w.ReactNativeWebView.postMessage(JSON.stringify({type:'nessie:external-auth-delivered',id:${id}}));}`
    + `catch(e){}})();`
}

export const externalAuthErrorResult = (state?: string): ExternalAuthTerminalResult =>
  mapExternalAuthSessionResult({ type: 'error' }, state)
