import type { ExpectedWorkspaceTarget } from './auth-session.js'

const PENDING_EXTERNAL_AUTH_KEY = 'nessie.pendingExternalAuth'

// Bounds for every caller-influenced string persisted in the pending record.
// UOA org/team ids, provider ids, team hints, and return paths are all
// short identifiers or in-app routes; anything longer is refused up front.
const MAX_EXTERNAL_ID_LENGTH = 256
const MAX_RETURN_PATH_LENGTH = 512
// Code verifiers are 43-128 chars per RFC 7636; states are short opaque
// randoms. Both are refused outright when unbounded rather than persisted.
const MAX_SECRET_LENGTH = 256
const MAX_STATE_LENGTH = 512

// Reject backslashes and ASCII controls outright: a browser URL parser treats
// them as alternate separators or strips them, which is exactly how a stored
// intent escapes its intended target.
const isCleanText = (value: string): boolean =>
  !/[\\\u0000-\u001f\u007f]/.test(value)

const isBoundedId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= MAX_EXTERNAL_ID_LENGTH
  && isCleanText(value)

const isBoundedSecret = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= MAX_SECRET_LENGTH
  && isCleanText(value)

const isBoundedState = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= MAX_STATE_LENGTH
  && isCleanText(value)

// Only in-app absolute paths may be restored after an exchange. A leading `//`
// is protocol-relative, a backslash is an alternate separator in URL parsers,
// and an ASCII control never reaches a router.
const sanitizeReturnPath = (value: string | undefined): string | undefined =>
  value
  && value.startsWith('/')
  && !value.startsWith('//')
  && isCleanText(value)
  && value.length <= MAX_RETURN_PATH_LENGTH
    ? value
    : undefined

// Minimal, framework-neutral key/value store. On web this is backed by
// `window.sessionStorage`; on React Native the host injects an equivalent.
export type PkceStorage = {
  getItem: (key: string) => string | null
  removeItem: (key: string) => void
  setItem: (key: string, value: string) => void
}

// Exact external (UOA) workspace a reauthorization flow must land on. Stored
// with the PKCE entry so an authenticated recovery can verify the exchanged
// session before applying it, and a plain login can refuse a mismatched one.
export type PendingExternalAuthTarget = ExpectedWorkspaceTarget

export type PendingExternalAuth = {
  claimed?: boolean
  codeVerifier: string
  providerId: string
  // App route to land on after the exchange completes (defaults to /channels).
  returnPath?: string
  state: string
  targetWorkspace?: PendingExternalAuthTarget
  teamHint?: string
  theme?: string
}

export type BeginExternalAuthResult = {
  authorizeUrl: string
  state: string
}

export type PendingExternalAuthClaim =
  | { kind: 'absent' }
  | { kind: 'claimed'; pending: PendingExternalAuth }
  | { kind: 'state-mismatch'; pending: PendingExternalAuth }

export type BeginExternalAuthInput = {
  // Absolute API base URL (already resolved by the host app).
  baseUrl: string
  // Optional base used to resolve a relative `baseUrl` (web passes
  // `window.location.origin`); unused when `baseUrl` is absolute.
  origin?: string
  providerId: string
  redirectUri: string
  // App route to land on after the exchange completes (defaults to /channels).
  returnPath?: string
  storage: PkceStorage
  targetWorkspace?: PendingExternalAuthTarget
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
  returnPath,
  storage,
  targetWorkspace,
  teamHint,
  theme,
}: BeginExternalAuthInput): Promise<BeginExternalAuthResult> => {
  if (readPendingExternalAuth(storage)) {
    throw new Error('An external sign-in is already in progress.')
  }
  const codeVerifier = randomString()
  const state = randomString()

  // providerId names the authorize endpoint; it must be bounded before it is
  // persisted with the exchange entry.
  if (!isBoundedId(providerId)) {
    throw new Error('The external auth provider id must be a bounded identifier.')
  }
  const sanitizedTheme = theme !== undefined && isBoundedId(theme) ? theme : undefined
  const sanitizedReturnPath = sanitizeReturnPath(returnPath)
  const sanitizedTeamHint = isBoundedId(teamHint) ? teamHint : undefined
  if (
    targetWorkspace
    && (
      !isBoundedId(targetWorkspace.organizationId)
      || !isBoundedId(targetWorkspace.teamId)
    )
  ) {
    throw new Error('The workspace-switch target must carry bounded organization and team ids.')
  }

  storage.setItem(
    PENDING_EXTERNAL_AUTH_KEY,
    JSON.stringify({
      codeVerifier,
      providerId,
      ...(sanitizedReturnPath ? { returnPath: sanitizedReturnPath } : {}),
      state,
      ...(targetWorkspace ? { targetWorkspace } : {}),
      ...(sanitizedTeamHint ? { teamHint: sanitizedTeamHint } : {}),
      ...(sanitizedTheme ? { theme } : {}),
    } satisfies PendingExternalAuth),
  )

  try {
    // The pending record is reserved before the first await. Two callers in
    // the same turn therefore cannot both create usable state-less UOA flows.
    const codeChallenge = await createCodeChallenge(codeVerifier)
    const authorizeUrl = new URL(
      `${baseUrl}/api/auth/providers/${encodeURIComponent(providerId)}/authorize`,
      origin,
    )
    authorizeUrl.searchParams.set('codeChallenge', codeChallenge)
    authorizeUrl.searchParams.set('redirectUri', redirectUri)
    authorizeUrl.searchParams.set('state', state)
    if (sanitizedTheme) authorizeUrl.searchParams.set('theme', sanitizedTheme)
    if (sanitizedTeamHint) authorizeUrl.searchParams.set('teamHint', sanitizedTeamHint)

    const response = await fetch(authorizeUrl.toString())
    if (!response.ok) {
      throw new Error(await response.text())
    }

    const payload = (await response.json()) as { data: { authorizeUrl: string } }
    return { authorizeUrl: payload.data.authorizeUrl, state }
  } catch (error) {
    // A second deliberate launch may replace this intent while the authorize
    // request is in flight. Retire only the record this request created.
    clearPendingExternalAuthMatching(storage, state)
    throw error
  }
}

export const clearPendingExternalAuth = (storage: PkceStorage): void => {
  storage.removeItem(PENDING_EXTERNAL_AUTH_KEY)
}

export const clearPendingExternalAuthMatching = (
  storage: PkceStorage,
  state: string,
): boolean => {
  const pending = readPendingExternalAuth(storage)
  if (!pending || pending.state !== state) return false
  clearPendingExternalAuth(storage)
  return true
}

// In-memory storage for hosts without Web Storage (React Native shells,
// tests). The pending record is process-lifetime there, which still binds
// one authorize flow to one callback.
export const createMemoryPkceStorage = (): PkceStorage => {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    removeItem: (key) => {
      entries.delete(key)
    },
    setItem: (key, value) => {
      entries.set(key, value)
    },
  }
}

// A stored entry is usable only when every field is present and bounded; a
// malformed record is discarded and reported as absent so a callback never
// exchanges against a tampered intent.
const isUsablePending = (value: unknown): value is PendingExternalAuth => {
  if (typeof value !== 'object' || value === null) return false
  const pending = value as Partial<PendingExternalAuth>
  if (
    (pending.claimed !== undefined && typeof pending.claimed !== 'boolean')
    ||
    !isBoundedSecret(pending.codeVerifier)
    || !isBoundedId(pending.providerId)
    || !isBoundedState(pending.state)
  ) {
    return false
  }
  if (pending.returnPath !== undefined && sanitizeReturnPath(pending.returnPath) === undefined) {
    return false
  }
  if (pending.teamHint !== undefined && !isBoundedId(pending.teamHint)) {
    return false
  }
  if (pending.theme !== undefined && !isBoundedId(pending.theme)) {
    return false
  }
  if (pending.targetWorkspace !== undefined) {
    const target = pending.targetWorkspace
    if (
      typeof target !== 'object'
      || target === null
      || !isBoundedId(target.organizationId)
      || !isBoundedId(target.teamId)
    ) {
      return false
    }
  }
  return true
}

export const readPendingExternalAuth = (storage: PkceStorage): PendingExternalAuth | null => {
  const value = storage.getItem(PENDING_EXTERNAL_AUTH_KEY)
  if (!value) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(value)
    if (!isUsablePending(parsed)) {
      clearPendingExternalAuth(storage)
      return null
    }
    return parsed
  } catch {
    clearPendingExternalAuth(storage)
    return null
  }
}

/**
 * Atomically claims the one pending intent before an async exchange starts.
 * A supplied stale state never destroys a newer launch. Missing state is
 * accepted for providers that rely on the PKCE verifier alone.
 */
export const claimPendingExternalAuth = (
  storage: PkceStorage,
  state: string | null,
): PendingExternalAuthClaim => {
  const pending = readPendingExternalAuth(storage)
  if (!pending) return { kind: 'absent' }
  if (pending.claimed) return { kind: 'absent' }
  if (state !== null && state !== pending.state) {
    return { kind: 'state-mismatch', pending }
  }
  storage.setItem(PENDING_EXTERNAL_AUTH_KEY, JSON.stringify({ ...pending, claimed: true }))
  return { kind: 'claimed', pending }
}
