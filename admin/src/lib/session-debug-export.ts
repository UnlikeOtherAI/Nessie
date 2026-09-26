import type { MeResponse } from '@nessie/schemas'
import { getBaseUrl } from './api-client'
import { loadStoredToken } from './storage'

// Decode the payload segment of a JWT without verifying it — purely so the
// claims (org / project / team / exp) are visible in the dump alongside the
// raw token. Never throws; returns a diagnostic object on malformed input.
const decodeJwtPayload = (token: string | null): unknown => {
  if (!token) return null
  const segment = token.split('.')[1]
  if (!segment) return { error: 'not a JWT (no payload segment)' }
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    )
    return JSON.parse(json)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'decode failed' }
  }
}

const readLocalStorage = (): Record<string, string> => {
  const entries: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key) entries[key] = localStorage.getItem(key) ?? ''
  }
  return entries
}

const readCookies = (): Record<string, string> => {
  const entries: Record<string, string> = {}
  if (!document.cookie) return entries
  for (const pair of document.cookie.split('; ')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    const key = pair.slice(0, separator)
    entries[key] = decodeURIComponent(pair.slice(separator + 1))
  }
  return entries
}

/**
 * The signed-in session — token and decoded claims, plus every localStorage and
 * cookie value — as pretty JSON, so it can be copied and handed to someone
 * debugging "what I see", or pasted into another device's sign-in screen
 * (`session-debug-import.ts` reads it back).
 */
export const buildSessionDebugDump = (me: MeResponse | null): string => {
  const token = loadStoredToken()
  const payload = {
    apiBaseUrl: getBaseUrl() || window.location.origin,
    tokens: {
      accessToken: token,
      accessTokenDecoded: decodeJwtPayload(token),
      refreshToken:
        '(httpOnly cookie "nessie_refresh" — not readable by JavaScript by design)',
    },
    session: me?.session ?? null,
    context: me?.context ?? null,
    auth: me?.auth ?? null,
    user: me?.user ?? null,
    localStorage: readLocalStorage(),
    cookies: readCookies(),
  }
  return JSON.stringify(payload, null, 2)
}
