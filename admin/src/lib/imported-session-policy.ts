import type { StoredTokenMode } from './storage'

export type SessionCredentialSnapshot = {
  mode: StoredTokenMode
  token: string | null
}

export const IMPORTED_SESSION_SCOPE_MESSAGE =
  'Imported sessions cannot switch teams. Copy a session dump from the team you need.'

export const createImportedSessionApplyTracker = () => {
  const counts = new Map<string, number>()

  return {
    add(token: string): void {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    },
    delete(token: string): void {
      const count = counts.get(token) ?? 0
      if (count <= 1) counts.delete(token)
      else counts.set(token, count - 1)
    },
    has(token: string): boolean {
      return (counts.get(token) ?? 0) > 0
    },
    tokens(): string[] {
      return [...counts.keys()]
    },
  }
}

export const canUseRefreshCookie = (input: {
  currentImportedToken: string | null
  currentToken: string | null
  expected?: SessionCredentialSnapshot
}): boolean => {
  if (input.expected && input.expected.token !== input.currentToken) return false
  if (input.expected?.mode === 'imported') return false
  return input.currentToken === null || input.currentImportedToken !== input.currentToken
}

export type SessionRefreshAction = 'clear-imported' | 'none' | 'refresh'

/**
 * A 401 belongs to the ApiClient generation that issued the request. Never let
 * a stale client clear a replacement import or join an in-flight import and
 * receive its bearer as a refresh result.
 */
export const resolveSessionRefreshAction = (input: {
  currentImportedToken: string | null
  currentToken: string | null
  expected?: SessionCredentialSnapshot
  importInFlight: boolean
}): SessionRefreshAction => {
  if (input.importInFlight) return 'none'
  if (canUseRefreshCookie(input)) return 'refresh'

  const currentIsImported = Boolean(
    input.currentToken && input.currentImportedToken === input.currentToken,
  )
  const targetsCurrentImport = !input.expected || (
    input.expected.mode === 'imported'
    && input.expected.token === input.currentToken
  )
  return currentIsImported && targetsCurrentImport ? 'clear-imported' : 'none'
}

export const isSessionCredentialCurrent = (input: {
  currentImportedToken: string | null
  currentToken: string | null
  expected: SessionCredentialSnapshot
}): boolean => {
  if (input.expected.token !== input.currentToken) return false
  const currentMode: StoredTokenMode = input.currentToken
    && input.currentImportedToken === input.currentToken
    ? 'imported'
    : 'renewable'
  return input.expected.mode === currentMode
}

/** Freeze logout ownership before any asynchronous termination work begins. */
export const resolveTerminatingSessionCredential = (input: {
  initiating: SessionCredentialSnapshot
  pendingImportedTokens: readonly string[]
  terminalToken: string | null
}): SessionCredentialSnapshot => {
  const token = input.terminalToken ?? input.initiating.token
  const imported = Boolean(token && (
    (input.initiating.mode === 'imported' && input.initiating.token === token)
    || input.pendingImportedTokens.includes(token)
  ))
  return { mode: imported ? 'imported' : 'renewable', token }
}

/**
 * Query cancellation is asynchronous. Recheck the exact bearer afterwards so
 * an expiring imported session can never erase a replacement login that was
 * applied while cancellation was in flight.
 */
export const clearSessionIfCurrent = async (input: {
  clearQueries: () => Promise<void>
  commit: () => void
  expectedToken: string
  readCurrentToken: () => string | null
}): Promise<boolean> => {
  if (input.readCurrentToken() !== input.expectedToken) return false
  await input.clearQueries()
  if (input.readCurrentToken() !== input.expectedToken) return false
  input.commit()
  return true
}

