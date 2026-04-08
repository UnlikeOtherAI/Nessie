import { getBaseUrl } from './api-client'

const PENDING_EXTERNAL_AUTH_KEY = 'nessie.pendingExternalAuth'

type PendingExternalAuth = {
  codeVerifier: string
  providerId: string
  state: string
}

const randomString = (): string => {
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const toBase64Url = (value: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

const createCodeChallenge = async (codeVerifier: string): Promise<string> => {
  const digest = await window.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  )
  return toBase64Url(digest)
}

export const beginExternalAuth = async (providerId: string, redirectUri: string): Promise<string> => {
  const codeVerifier = randomString()
  const state = randomString()
  const codeChallenge = await createCodeChallenge(codeVerifier)

  window.sessionStorage.setItem(
    PENDING_EXTERNAL_AUTH_KEY,
    JSON.stringify({
      codeVerifier,
      providerId,
      state,
    } satisfies PendingExternalAuth),
  )

  const authorizeUrl = new URL(
    `${getBaseUrl()}/api/auth/providers/${encodeURIComponent(providerId)}/authorize`,
    window.location.origin,
  )
  authorizeUrl.searchParams.set('codeChallenge', codeChallenge)
  authorizeUrl.searchParams.set('redirectUri', redirectUri)
  authorizeUrl.searchParams.set('state', state)

  const response = await fetch(authorizeUrl.toString())
  if (!response.ok) {
    throw new Error(await response.text())
  }

  const payload = (await response.json()) as { data: { authorizeUrl: string } }
  return payload.data.authorizeUrl
}

export const clearPendingExternalAuth = (): void => {
  window.sessionStorage.removeItem(PENDING_EXTERNAL_AUTH_KEY)
}

export const readPendingExternalAuth = (): PendingExternalAuth | null => {
  const value = window.sessionStorage.getItem(PENDING_EXTERNAL_AUTH_KEY)
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value) as PendingExternalAuth
  } catch {
    clearPendingExternalAuth()
    return null
  }
}
