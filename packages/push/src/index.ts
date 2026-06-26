/**
 * @nessie/push — framework-agnostic APNs + FCM + Web Push senders.
 *
 * Given already-decrypted credentials, a target, and a payload, deliver a push
 * directly via Apple APNs (HTTP/2 + .p8 ES256 JWT), Google FCM (HTTP v1 +
 * service-account OAuth), or browser Web Push (RFC 8291 encryption + RFC 8292
 * VAPID). No database, no stored-secret access, no tenant context — credentials
 * are passed in as plain objects.
 */
export { sendApns, ApnsClient, buildApnsBody } from './apns.js'
export { sendFcm, FcmClient, buildFcmBody, parseServiceAccount } from './fcm.js'
export { PushSender, type PushSenderOptions } from './push-sender.js'
export {
  sendWebPush,
  WebPushClient,
  type WebPushFetch,
  type WebPushFetchResponse,
  type WebPushSendOptions,
} from './webpush.js'
export { encryptWebPushPayload, type WebPushEncryptInput } from './webpush-crypto.js'
export {
  mintVapidJwt,
  buildVapidAuthHeader,
  loadVapidPrivateKey,
  assertValidVapidSubject,
  type VapidKeys,
} from './vapid.js'
export type {
  ApnsCredentials,
  FcmCredentials,
  PushPayload,
  PushTarget,
  PushResult,
  WebPushCredentials,
  WebPushTarget,
} from './types.js'
export type {
  ApnsTransport,
  ApnsTransportFactory,
  Http2Request,
  Http2Response,
  FetchLike,
  FetchLikeResponse,
} from './transport.js'
