const AUTH_CALLBACK_URL = 'nessie://auth/callback'
const CANCEL_CALLBACK_URL = `${AUTH_CALLBACK_URL}?error=access_denied`
const ERROR_CALLBACK_URL = `${AUTH_CALLBACK_URL}?error=native_auth_error`

export type ExternalAuthTerminalResult =
  | { callbackUrl: string; kind: 'callback' }
  | { callbackUrl: string; kind: 'cancelled' }
  | { callbackUrl: string; kind: 'error' }

const withLaunchState = (value: string, state?: string): string => {
  if (!state) return value
  try {
    const url = new URL(value)
    if (!url.searchParams.has('state')) url.searchParams.set('state', state)
    return url.toString()
  } catch {
    return value
  }
}

export const mapExternalAuthSessionResult = (
  result: { type: string; url?: string },
  state?: string,
): ExternalAuthTerminalResult => {
  if (result.type === 'success' && result.url) {
    return { callbackUrl: withLaunchState(result.url, state), kind: 'callback' }
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

/** Acknowledge only after SPA completion; reloads retain and redeliver the result. */
export const nativeExternalAuthDeliveryScript = (
  delivery: NativeExternalAuthDelivery,
): string => {
  const id = JSON.stringify(delivery.id)
  const url = JSON.stringify(delivery.url)
  return `(function(){var w=window;if(typeof w.__nessieExternalAuthCallback!=='function')return;`
    + `var p;try{p=w.__nessieExternalAuthCallback(${url});}catch(e){return;}`
    + `Promise.resolve(p).then(function(){try{w.ReactNativeWebView.postMessage(JSON.stringify(`
    + `{type:'nessie:external-auth-delivered',id:${id}}));}catch(e){}}).catch(function(){});})()`
}

export const externalAuthErrorResult = (state?: string): ExternalAuthTerminalResult =>
  mapExternalAuthSessionResult({ type: 'error' }, state)
