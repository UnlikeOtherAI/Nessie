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
      "They've already accepted this invitation. To take away their access, remove them from the team.")
    return true
  }
  if (error instanceof UoaRosterIdentityError
    || (error instanceof UoaRosterRejectedError && error.statusCode === 401)) {
    sendApiError(reply, 403, 'UOA_SESSION_REQUIRED',
      "We couldn't confirm your sign-in. Sign in again, open this team and try once more.")
    return true
  }
  if (error instanceof UoaRosterRejectedError) {
    const messages: Record<number, string> = {
      400: "That change didn't go through. Check the details and try again.",
      403: "You don't have permission to do this any more. Refresh the page to see what you can change.",
      404: "That person or invitation isn't here any more. Refresh the page.",
      409: 'This conflicts with their current membership or an existing invitation. Refresh the page and try again.',
      429: 'Too many changes at once. Wait a moment and try again.',
    }
    sendApiError(reply, error.statusCode,
      scope === 'team' ? 'TEAM_MEMBERS_REJECTED' : 'ORGANIZATION_MEMBERS_REJECTED',
      messages[error.statusCode] ?? "That change didn't go through. Refresh the page and try again.")
    return true
  }
  if (error instanceof UoaRosterUnavailableError) {
    request.log.warn({ err: error }, 'uoa member management relay failed')
    sendApiError(reply, 502, 'UOA_DIRECTORY_UNAVAILABLE',
      'Members and invitations are unavailable right now. Try again in a few minutes.')
    return true
  }
  return false
}
