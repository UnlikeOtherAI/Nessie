const PENDING_EXTERNAL_AUTH_KEY = 'nessie.pendingExternalAuth'

// Minimal, framework-neutral key/value store. On web this is backed by
// `window.sessionStorage`; on React Native the host injects an equivalent.
export type PkceStorage = {
  getItem: (key: string) => string | null
  removeItem: (key: string) => void
  setItem: (key: string, value: string) => void
}

export type PendingExternalAuth = {
  codeVerifier: string
  providerId: string
  state: string
  theme?: string
}

export type BeginExternalAuthInput = {
  // Absolute API base URL (already resolved by the host app).
  baseUrl: string
  // Optional base used to resolve a relative `baseUrl` (web passes
  // `window.location.origin`); unused when `baseUrl` is absolute.
  origin?: string
  providerId: string
  redirectUri: string
  storage: PkceStorage
  teamHint?: string
  theme?: string
}

const randomString = (): string => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const toBase64Url = (value: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

const createCodeChallenge = async (codeVerifier: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  )
  return toBase64Url(digest)
}

export const beginExternalAuth = async ({
  baseUrl,
  origin,
  providerId,
  redirectUri,
  storage,
  teamHint,
  theme,
}: BeginExternalAuthInput): Promise<string> => {
  const codeVerifier = randomString()
  const state = randomString()
  const codeChallenge = await createCodeChallenge(codeVerifier)

  storage.setItem(
    PENDING_EXTERNAL_AUTH_KEY,
    JSON.stringify({
      codeVerifier,
      providerId,
      state,
      theme,
    } satisfies PendingExternalAuth),
  )

  const authorizeUrl = new URL(
    `${baseUrl}/api/auth/providers/${encodeURIComponent(providerId)}/authorize`,
    origin,
  )
  authorizeUrl.searchParams.set('codeChallenge', codeChallenge)
  authorizeUrl.searchParams.set('redirectUri', redirectUri)
  authorizeUrl.searchParams.set('state', state)
  if (theme) {
    authorizeUrl.searchParams.set('theme', theme)
  }
  if (teamHint) {
    authorizeUrl.searchParams.set('teamHint', teamHint)
  }

  const response = await fetch(authorizeUrl.toString())
  if (!response.ok) {
    throw new Error(await response.text())
  }

  const payload = (await response.json()) as { data: { authorizeUrl: string } }
  return payload.data.authorizeUrl
}

export const clearPendingExternalAuth = (storage: PkceStorage): void => {
  storage.removeItem(PENDING_EXTERNAL_AUTH_KEY)
}

export const readPendingExternalAuth = (storage: PkceStorage): PendingExternalAuth | null => {
  const value = storage.getItem(PENDING_EXTERNAL_AUTH_KEY)
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value) as PendingExternalAuth
  } catch {
    clearPendingExternalAuth(storage)
    return null
  }
}
