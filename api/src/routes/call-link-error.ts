import type { FastifyReply } from 'fastify'

import { CallLinkError } from '@nessie/workspace-admin'
import { sendApiError } from '../lib/api.js'

export const sendCallLinkError = (reply: FastifyReply, error: CallLinkError): void => {
  if (error.code === 'TEAM_NOT_FOUND') {
    sendApiError(reply, 404, error.code, 'Team not found')
    return
  }
  if (error.code === 'MEET_LINK_FAILED') {
    sendApiError(reply, 502, error.code, 'Google Meet could not create a link')
    return
  }
  const messages: Record<Exclude<typeof error.code, 'TEAM_NOT_FOUND' | 'MEET_LINK_FAILED'>, string> = {
    GOOGLE_ACCOUNT_AMBIGUOUS:
    'You have more than one Google account connected. Open '
    + '/settings/connections and disconnect the one you do not want used, or '
    + 'say which account to use.',
  GOOGLE_NOT_CONNECTED: 'Connect Google before creating a Meet link',
    MEET_SCOPE_MISSING: 'Reconnect Google and grant the Meet space scope',
    GOOGLE_REAUTH_REQUIRED: 'Reconnect Google before creating a Meet link',
    PROVIDER_NOT_CONFIGURED: 'The selected call provider is not configured',
  }
  sendApiError(reply, 409, error.code, messages[error.code])
}
