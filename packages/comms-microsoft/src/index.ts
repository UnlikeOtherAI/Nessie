export { createMicrosoftConnector } from './connector.js'
export {
  MICROSOFT_MAIL_READ_SCOPE,
  MICROSOFT_USER_READ_SCOPE,
  requestedMicrosoftScopes,
  type MicrosoftConnectorDeps,
} from './config.js'
export {
  MicrosoftApiError,
  MicrosoftDeltaCursorExpiredError,
  MicrosoftReauthorizationRequiredError,
} from './errors.js'
export {
  MicrosoftIdentityError,
  readMicrosoftAccountIdentity,
  readMicrosoftTokenIdentity,
  type MicrosoftAccountIdentity,
  type MicrosoftTokenIdentity,
} from './identity.js'
export {
  MICROSOFT_MAIL_VISIBILITY,
  normalizeMicrosoftDeletion,
  normalizeMicrosoftMessage,
} from './normalize.js'
export { decodeMicrosoftDeltaCursor } from './sync.js'
export type { FetchLike, FetchResponse } from './http.js'
