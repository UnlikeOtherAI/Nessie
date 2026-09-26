import type { FastifyReply } from 'fastify'

import { sendApiError } from '../lib/api.js'
import { AnnouncementAudienceIncompleteError } from '../services/announcement-audience.js'
import {
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
} from '../services/uoa-org-roster.js'

/** A partial roster must never turn into a partially delivered announcement. */
export const sendAnnouncementAudienceError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof AnnouncementAudienceIncompleteError
    || error instanceof UoaRosterUnavailableError) {
    sendApiError(reply, 503, 'ANNOUNCEMENT_AUDIENCE_UNAVAILABLE',
      'Announcement recipients could not be verified. Try again shortly.')
    return true
  }
  if (error instanceof UoaRosterIdentityError || error instanceof UoaRosterRejectedError) {
    sendApiError(reply, 403, 'ANNOUNCEMENT_AUDIENCE_FORBIDDEN',
      'Announcement recipients could not be verified for this sign-in.')
    return true
  }
  return false
}
