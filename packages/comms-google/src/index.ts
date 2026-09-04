export { createGoogleConnector } from './connector.js'
export type { GoogleConnectorDeps } from './config.js'
export {
  GMAIL_READONLY_SCOPE,
  DEFAULT_OFF_LABELS,
  decodeHistoryCursor,
  decodeIncrementalCursor,
  encodeCursor,
  type HistoryCursor,
  type IncrementalCursor,
} from './config.js'
export {
  GmailApiError,
  GmailHistoryExpiredError,
  GmailReauthorizationRequiredError,
} from './errors.js'
export {
  decodePubSubNotification,
  GmailPubSubDecodeError,
  type GmailPubSubNotification,
} from './pubsub.js'
export {
  normalizeGmailMessage,
  normalizeGmailDeletion,
  GMAIL_VISIBILITY,
} from './normalize.js'
export {
  readGoogleIdentity,
  GoogleIdentityError,
  type GoogleAccountIdentity,
} from './identity.js'
export { isScopeReason } from './http.js'
export {
  createGoogleMeetSpace,
  GOOGLE_MEET_CREATE_SCOPE,
  GoogleMeetApiError,
} from './meet.js'
export type { FetchLike, FetchResponse } from './http.js'

export {
  buildRawMessage,
  canonicalDraftFingerprintInput,
  MimeBuildError,
  type GmailDraftAttachmentIdentity,
  type OutboundMessage,
  type OutboundAttachment,
} from './gmail/mime-build.js'
export {
  createGmailDraft,
  updateGmailDraft,
  getGmailDraft,
  deleteGmailDraft,
  sendGmailDraft,
  sendGmailMessage,
  type GmailDraftRef,
  type GmailDraftContent,
} from './gmail/drafts.js'
export {
  searchGmailThreads,
  getGmailMessage,
  getGmailThread,
  type GmailThreadSummary,
  type GmailMessageDetail,
} from './gmail/read.js'
export {
  listGmailMailThreads,
  readGmailMailThread,
  type GmailMailConversation,
  type GmailMailThreadPage,
} from './gmail/mail-surface.js'

export {
  listCalendars,
  listEvents,
  queryFreeBusy,
  createEvent,
  patchEvent,
  deleteEvent,
  type CalendarSummary,
  type CalendarEvent,
  type BusyBlock,
  type CreateEventInput,
} from './calendar/client.js'

export { respondToEvent } from './calendar/client.js'
export {
  listGmailLabels,
  modifyGmailThread,
  trashGmailThread,
  getGmailAttachment,
  type GmailLabelRef,
} from './gmail/read.js'
export {
  searchGoogleContacts,
  type GoogleContact,
} from './contacts/people.js'
