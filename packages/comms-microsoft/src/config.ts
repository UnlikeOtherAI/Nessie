import type { FetchLike } from './http.js'

export const MICROSOFT_MAIL_READ_SCOPE = 'Mail.Read'
export const MICROSOFT_USER_READ_SCOPE = 'User.Read'

const DEFAULT_PAGE_SIZE = 50

/**
 * The Microsoft adapter has no ambient configuration: both API and worker
 * inject its transport, OAuth registration and clock through this boundary.
 */
export type MicrosoftConnectorDeps = {
  fetch: FetchLike
  clientId: string
  clientSecret?: string
  pageSize?: number
  now?: () => number
}

export const resolvePageSize = (deps: MicrosoftConnectorDeps): number =>
  deps.pageSize && deps.pageSize > 0
    ? Math.min(Math.floor(deps.pageSize), 100)
    : DEFAULT_PAGE_SIZE

export const nowMs = (deps: MicrosoftConnectorDeps): number =>
  deps.now ? deps.now() : Date.now()

export const requestedMicrosoftScopes = (): string[] => [
  MICROSOFT_MAIL_READ_SCOPE,
  MICROSOFT_USER_READ_SCOPE,
  'openid',
  'profile',
  'email',
  'offline_access',
]
