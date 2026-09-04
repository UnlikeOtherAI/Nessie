import {
  MimeBuildError,
  prepareGmailDraft,
  type OutboundMessage,
  type PreparedGmailDraft,
} from '@nessie/comms-google'

import { GmailDraftError } from './gmail-drafts.js'

/** Convert deterministic local MIME failures into a stable, non-sensitive remedy. */
export const preflightGmailDraft = (
  message: OutboundMessage,
  threadId?: string,
): PreparedGmailDraft => {
  try {
    return prepareGmailDraft(message, threadId)
  } catch (error) {
    if (error instanceof MimeBuildError) {
      throw new GmailDraftError('INVALID_MESSAGE', 'email contents are invalid')
    }
    throw error
  }
}
