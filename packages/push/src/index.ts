/**
 * @nessie/push — framework-agnostic APNs + FCM senders.
 *
 * Given already-decrypted credentials, a device token, and a payload, deliver a
 * push directly via Apple APNs (HTTP/2 + .p8 ES256 JWT) and Google FCM (HTTP v1
 * + service-account OAuth). No database, no stored-secret access, no tenant
 * context — credentials are passed in as plain objects.
 */
export { sendApns, ApnsClient, buildApnsBody } from './apns.js'
export { sendFcm, FcmClient, buildFcmBody, parseServiceAccount } from './fcm.js'
export { PushSender, type PushSenderOptions } from './push-sender.js'
export type {
  ApnsCredentials,
  FcmCredentials,
  PushPayload,
  PushTarget,
  PushResult,
} from './types.js'
export type {
  ApnsTransport,
  ApnsTransportFactory,
  Http2Request,
  Http2Response,
  FetchLike,
  FetchLikeResponse,
} from './transport.js'
