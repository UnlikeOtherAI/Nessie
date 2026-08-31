import {
  beginExternalAuth as coreBeginExternalAuth,
  claimPendingExternalAuth as coreClaimPendingExternalAuth,
  clearPendingExternalAuth as coreClearPendingExternalAuth,
  clearPendingExternalAuthMatching as coreClearPendingExternalAuthMatching,
  createCompletedExternalAuthCallbackCache,
  createMemoryPkceStorage,
  readPendingExternalAuth as coreReadPendingExternalAuth,
  type PendingExternalAuth,
  type BeginExternalAuthResult,
  type PendingExternalAuthClaim,
  type PendingExternalAuthTarget,
  type PkceStorage,
} from '@nessie/client-core'
import type { AppliedTheme } from '../providers/ThemeProvider'
import { getBaseUrl } from './api-client'

// Web binds the framework-neutral PKCE helpers to browser sessionStorage and
// the Vite-resolved API base URL. React Native would inject its own storage.
// `typeof window` keeps the module importable from Node tests, which fall
// back to a process-lifetime store.
const storage: PkceStorage = typeof window === 'undefined'
  ? createMemoryPkceStorage()
  : window.sessionStorage

export const completedExternalAuthCallbackCache =
  createCompletedExternalAuthCallbackCache(storage)

export const beginExternalAuth = (input: {
  origin?: string
  providerId: string
  replacePendingState?: string
  redirectUri: string
  returnPath?: string
  targetWorkspace?: PendingExternalAuthTarget
  teamHint?: string
  theme: AppliedTheme
}): Promise<BeginExternalAuthResult> => {
  const origin = input.origin
    ?? (typeof window === 'undefined' ? undefined : window.location.origin)
  return coreBeginExternalAuth({
    baseUrl: getBaseUrl(),
    origin,
    providerId: input.providerId,
    ...(input.replacePendingState ? { replacePendingState: input.replacePendingState } : {}),
    redirectUri: input.redirectUri,
    ...(input.returnPath ? { returnPath: input.returnPath } : {}),
    storage,
    ...(input.targetWorkspace ? { targetWorkspace: input.targetWorkspace } : {}),
    ...(input.teamHint ? { teamHint: input.teamHint } : {}),
    theme: input.theme,
  })
}

export const clearPendingExternalAuth = (): void => coreClearPendingExternalAuth(storage)

export const clearPendingExternalAuthMatching = (state: string): boolean =>
  coreClearPendingExternalAuthMatching(storage, state)

export const claimPendingExternalAuth = (state: string | null): PendingExternalAuthClaim =>
  coreClaimPendingExternalAuth(storage, state)

export const readPendingExternalAuth = (): PendingExternalAuth | null =>
  coreReadPendingExternalAuth(storage)
