import type { AuthSessionApi, SessionPayload } from '@nessie/client-core'

const MAX_DEBUG_JSON_LENGTH = 1_000_000
const MAX_ACCESS_TOKEN_LENGTH = 32_768
const STORED_TOKEN_KEY = 'nessie.admin.token'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const normaliseApiBaseUrl = (value: string): string | null => {
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export type SessionDebugImport = {
  accessToken: string
}

export const shouldStartAutomaticSignIn = (input: {
  callbackInUrl: boolean
  hasAutoRedirectProvider: boolean
  sessionImportOpen: boolean
  unauthenticated: boolean
}): boolean => input.unauthenticated
  && !input.callbackInUrl
  && input.hasAutoRedirectProvider
  && !input.sessionImportOpen

/**
 * Extract the one credential the debug dump can actually transfer. Everything
 * else in the JSON is diagnostic and untrusted: never restore its storage,
 * cookies, decoded claims, user, or workspace context.
 */
export const parseSessionDebugImport = (
  raw: string,
  expectedApiBaseUrl: string,
): SessionDebugImport => {
  if (!raw.trim()) {
    throw new Error('Paste a session debug JSON dump.')
  }
  if (raw.length > MAX_DEBUG_JSON_LENGTH) {
    throw new Error('This session debug JSON is too large.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Paste valid session debug JSON.')
  }
  if (!isRecord(parsed) || !isRecord(parsed.tokens)) {
    throw new Error('This session dump does not contain an access token.')
  }

  const expectedBaseUrl = normaliseApiBaseUrl(expectedApiBaseUrl)
  const pastedBaseUrl = typeof parsed.apiBaseUrl === 'string'
    ? normaliseApiBaseUrl(parsed.apiBaseUrl)
    : null
  if (!expectedBaseUrl || !pastedBaseUrl || expectedBaseUrl !== pastedBaseUrl) {
    throw new Error('This session dump belongs to a different Nessie server.')
  }

  const accessToken = typeof parsed.tokens.accessToken === 'string'
    ? parsed.tokens.accessToken.trim()
    : ''
  if (!accessToken || accessToken.length > MAX_ACCESS_TOKEN_LENGTH) {
    throw new Error('This session dump does not contain a usable access token.')
  }

  if (isRecord(parsed.localStorage)) {
    const duplicatedToken = parsed.localStorage[STORED_TOKEN_KEY]
    if (typeof duplicatedToken === 'string' && duplicatedToken !== accessToken) {
      throw new Error('This session dump contains conflicting access tokens.')
    }
  }

  return { accessToken }
}

/** Ask the configured Nessie API for the authoritative identity behind a paste. */
export const resolveImportedSession = async (
  accessToken: string,
  fetchSession: AuthSessionApi['fetchSession'],
): Promise<SessionPayload> => {
  const snapshot = await fetchSession(accessToken)
  if (snapshot.kind === 'unauthenticated') {
    throw new Error('This session expired or was revoked. Copy a fresh dump.')
  }
  if (snapshot.kind !== 'authenticated') {
    throw new Error('This session cannot be imported.')
  }
  return { me: snapshot.me, token: accessToken }
}
