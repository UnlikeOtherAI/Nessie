import type { AppAuthMethod } from '@nessie/schemas'

import type { AppConnectScope } from '../../../facades/apps/connect-hooks'

/** The two deliberate audiences the Apps connect dialog offers. */
export type AppConnectScopeChoice = 'user' | 'channel'

/** A shared default is a deliberate API-key choice on a shared connection. */
export const canShareAppConnectionKey = (
  authMethod: AppAuthMethod,
  scopeChoice: AppConnectScopeChoice,
): boolean => authMethod === 'api_key' && scopeChoice !== 'user'

/**
 * Keeps the review dialog's selected audience and its request body in one
 * place. A channel connection is never inferred from a page or session
 * context: choosing Channel without naming one cannot start a connection.
 */
export const buildAppConnectScope = (
  choice: AppConnectScopeChoice,
  channelId: string,
): AppConnectScope | null => {
  if (choice === 'user') return { scopeType: 'user' }
  return channelId ? { scopeId: channelId, scopeType: 'channel' } : null
}

/** Copy paired with the audience choice, so the review and its consequences agree. */
export const appConnectScopeCopy = (
  choice: AppConnectScopeChoice,
  channelLabel?: string,
): string => {
  if (choice === 'user') {
    return 'Just you. You can choose which agents may use it after it connects.'
  }

  if (channelLabel) {
    return `A separate connection will be created for ${channelLabel}. You will add your own credential; only agents acting in that channel can use this connection.`
  }

  return 'Select a channel. A separate connection will be created for it. You will add your own credential; only agents acting in that channel can use this connection.'
}
