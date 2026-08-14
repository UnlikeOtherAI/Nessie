export type ExternalAuthCallback =
  | { code: string; kind: 'code'; state: string | null }
  | { kind: 'cancelled'; state: string | null }
  | { error: string; kind: 'provider-error'; state: string | null }

export type ExternalAuthCallbackEnvelope = {
  callback: ExternalAuthCallback
  redirectUri: string
}

const MAX_CALLBACK_PARAM_LENGTH = 512
const MAX_PENDING_CALLBACKS = 4
const MAX_HANDLED_CALLBACKS = 16

const bounded = (value: string | null): value is string => Boolean(
  value
  && value.length <= MAX_CALLBACK_PARAM_LENGTH
  && !/[\u0000-\u001f\u007f]/.test(value),
)

const parseCallbackParams = (url: URL): ExternalAuthCallback | null => {
  const codes = url.searchParams.getAll('code')
  const errors = url.searchParams.getAll('error')
  const states = url.searchParams.getAll('state')
  const state = states[0] ?? null
  if (states.length > 1 || (state !== null && !bounded(state))) return null

  if (codes.length === 1 && errors.length === 0 && bounded(codes[0] ?? null)) {
    return { code: codes[0] as string, kind: 'code', state }
  }
  if (errors.length === 1 && codes.length === 0 && bounded(errors[0] ?? null)) {
    const error = errors[0] as string
    return error === 'access_denied'
      ? { kind: 'cancelled', state }
      : { error, kind: 'provider-error', state }
  }
  return null
}

export const parseNativeAuthCallbackUrl = (value: string): ExternalAuthCallback | null => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.protocol !== 'nessie:'
    || url.hostname !== 'auth'
    || url.pathname !== '/callback'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.hash !== ''
  ) {
    return null
  }
  return parseCallbackParams(url)
}

export const parseWebAuthCallbackUrl = (
  value: string,
  expectedOrigin: string,
): ExternalAuthCallbackEnvelope | null => {
  let url: URL
  try {
    url = new URL(value, expectedOrigin)
  } catch {
    return null
  }
  if (url.origin !== expectedOrigin || url.pathname !== '/login' || url.hash !== '') return null
  const callback = parseCallbackParams(url)
  return callback ? { callback, redirectUri: `${expectedOrigin}/login` } : null
}

type NativeCallbackWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieExternalAuthCallback?: (url: string) => void
  __nessiePendingExternalAuthCallbacks?: string[]
}

const readEarlyCallbacks = (): string[] => {
  if (typeof window === 'undefined') return []
  const target = window as NativeCallbackWindow
  return Array.isArray(target.__nessiePendingExternalAuthCallbacks)
    ? target.__nessiePendingExternalAuthCallbacks.splice(0)
    : []
}

export const installEarlyNativeCallbackCollector = (): void => {
  if (typeof window === 'undefined') return
  const target = window as NativeCallbackWindow
  if (!target.ReactNativeWebView || target.__nessieExternalAuthCallback) return
  target.__nessieExternalAuthCallback = (url) => {
    const callbacks = target.__nessiePendingExternalAuthCallbacks
      ?? (target.__nessiePendingExternalAuthCallbacks = [])
    if (callbacks.length < MAX_PENDING_CALLBACKS && !callbacks.includes(url)) callbacks.push(url)
  }
}

const semanticKey = (envelope: ExternalAuthCallbackEnvelope): string => {
  const { callback } = envelope
  const values = callback.kind === 'code'
    ? [callback.kind, callback.code, callback.state ?? '']
    : callback.kind === 'provider-error'
      ? [callback.kind, callback.error, callback.state ?? '']
      : [callback.kind, callback.state ?? '']
  return values.map((value) => `${value.length}:${value}`).join('|')
}

export type ExternalAuthCallbackHub = {
  drainEarlyCallbacks: () => void
  handleNativeUrl: (url: string) => void
  handleWebUrl: (url: string, origin: string) => void
  setReady: (ready: boolean) => void
  submit: (envelope: ExternalAuthCallbackEnvelope) => void
}

/** Serial delivery with replay suppression only after completion claimed an intent. */
export const createExternalAuthCallbackHub = (
  onCallback: (envelope: ExternalAuthCallbackEnvelope) => Promise<boolean>,
): ExternalAuthCallbackHub => {
  const queued: ExternalAuthCallbackEnvelope[] = []
  const handled = new Map<string, true>()
  let ready = false
  let chain = Promise.resolve()

  const remember = (key: string): void => {
    handled.set(key, true)
    if (handled.size > MAX_HANDLED_CALLBACKS) {
      const oldest = handled.keys().next().value
      if (oldest) handled.delete(oldest)
    }
  }
  const flush = (): void => {
    if (!ready) return
    while (queued.length > 0) {
      const envelope = queued.shift()
      if (!envelope) continue
      chain = chain.then(async () => {
        const key = semanticKey(envelope)
        if (handled.has(key)) return
        if (await onCallback(envelope)) remember(key)
      }).catch(() => undefined)
    }
  }
  const submit = (envelope: ExternalAuthCallbackEnvelope): void => {
    if (queued.length >= MAX_PENDING_CALLBACKS) queued.shift()
    queued.push(envelope)
    flush()
  }
  const handleNativeUrl = (url: string): void => {
    const callback = parseNativeAuthCallbackUrl(url)
    if (callback) submit({ callback, redirectUri: 'nessie://auth/callback' })
  }

  return {
    drainEarlyCallbacks: () => readEarlyCallbacks().forEach(handleNativeUrl),
    handleNativeUrl,
    handleWebUrl: (url, origin) => {
      const envelope = parseWebAuthCallbackUrl(url, origin)
      if (envelope) submit(envelope)
    },
    setReady: (nextReady) => {
      ready = nextReady
      flush()
    },
    submit,
  }
}
