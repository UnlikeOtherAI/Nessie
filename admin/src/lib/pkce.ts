import {
  beginExternalAuth as coreBeginExternalAuth,
  clearPendingExternalAuth as coreClearPendingExternalAuth,
  readPendingExternalAuth as coreReadPendingExternalAuth,
  type PendingExternalAuth,
  type PkceStorage,
} from '@nessie/client-core'
import type { AppliedTheme } from '../providers/ThemeProvider'
import { getBaseUrl } from './api-client'

// Web binds the framework-neutral PKCE helpers to browser sessionStorage and
// the Vite-resolved API base URL. React Native would inject its own storage.
const storage: PkceStorage = window.sessionStorage

export const beginExternalAuth = (
  providerId: string,
  redirectUri: string,
  theme: AppliedTheme,
  teamHint?: string,
): Promise<string> =>
  coreBeginExternalAuth({
    baseUrl: getBaseUrl(),
    origin: window.location.origin,
    providerId,
    redirectUri,
    storage,
    teamHint,
    theme,
  })

export const clearPendingExternalAuth = (): void => coreClearPendingExternalAuth(storage)

export const readPendingExternalAuth = (): PendingExternalAuth | null =>
  coreReadPendingExternalAuth(storage)
