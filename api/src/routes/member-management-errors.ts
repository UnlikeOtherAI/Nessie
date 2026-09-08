import type { FastifyReply, FastifyRequest } from 'fastify'

import { sendApiError } from '../lib/api.js'
import {
  UoaInvitationAlreadyAcceptedError,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
} from '../services/uoa-org-roster.js'

/** Keep the same actionable, non-sensitive UOA errors on both member surfaces. */
export const sendMemberManagementError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  scope: 'team' | 'organization',
): boolean => {
  if (error instanceof UoaInvitationAlreadyAcceptedError) {
    sendApiError(reply, 409, 'INVITATION_ALREADY_ACCEPTED',
      'This invitation was already accepted. Remove the member instead.')
    return true
  }
  if (error instanceof UoaRosterIdentityError
    || (error instanceof UoaRosterRejectedError && error.statusCode === 401)) {
    sendApiError(reply, 403, 'UOA_SESSION_REQUIRED',
      'UnlikeOtherAI could not verify your session. Sign in again and select this team.')
    return true
  }
  if (error instanceof UoaRosterRejectedError) {
    const messages: Record<number, string> = {
      400: 'UnlikeOtherAI could not apply this change. Check the selected role and invitation details, then try again.',
      403: 'You no longer have permission to make this change. Refresh the members list to see your current access.',
      404: 'This member or invitation is no longer available. Refresh the members list.',
      409: 'This change conflicts with the current membership or invitation. Refresh the members list and try again.',
      429: 'Too many membership requests. Wait a moment and try again.',
    }
    sendApiError(reply, error.statusCode,
      scope === 'team' ? 'TEAM_MEMBERS_REJECTED' : 'ORGANIZATION_MEMBERS_REJECTED',
      messages[error.statusCode] ?? 'UnlikeOtherAI could not apply this change. Refresh the members list and try again.')
    return true
  }
  if (error instanceof UoaRosterUnavailableError) {
    request.log.warn({ err: error }, 'uoa member management relay failed')
    sendApiError(reply, 502, 'UOA_DIRECTORY_UNAVAILABLE',
      'The UnlikeOtherAI directory is temporarily unavailable. Try again shortly.')
    return true
  }
  return false
}
