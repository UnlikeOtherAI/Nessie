import type { AppAuthMethod } from '@nessie/schemas'

import type { AppConnectScope } from '../../../facades/apps/connect-hooks'

/** The deliberate audiences the Apps connect dialog offers. */
export type AppConnectScopeChoice = 'user' | 'channel' | 'project'

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
  scopeId: string,
): AppConnectScope | null => {
  if (choice === 'user') return { scopeType: 'user' }
  return scopeId ? { scopeId, scopeType: choice } : null
}

/** Copy paired with the audience choice, so the review and its consequences agree. */
export const appConnectScopeCopy = (
  choice: AppConnectScopeChoice,
  scopeLabel?: string,
): string => {
  if (choice === 'user') {
    return 'Just you. You can choose which agents may use it after it connects.'
  }

  if (choice === 'project') {
    if (scopeLabel) {
      return `A separate connection for ${scopeLabel}. Only agents working in this project can use it after access is granted.`
    }
    return 'Select a project. Only agents working in it can use the connection after access is granted.'
  }

  if (scopeLabel) {
    return `A separate connection for ${scopeLabel}. Only agents working in this channel can use it after access is granted.`
  }
  return 'Select a channel. Only agents working in it can use the connection after access is granted.'
}
