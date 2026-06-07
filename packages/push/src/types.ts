/**
 * Public input/output types for the push senders.
 *
 * Credentials are passed in as already-decrypted plain objects. This package
 * never reads stored secrets, never touches a database, and never knows about
 * tenants — a caller (a worker step) loads + decrypts credentials and hands
 * them to {@link sendApns} / {@link sendFcm}.
 */

/** Apple APNs token-auth (.p8) credentials, already decrypted. */
export interface ApnsCredentials {
  /** PEM-encoded PKCS#8 EC P-256 private key (the contents of the .p8 file). */
  p8: string
  /** Apple Key ID for the .p8 key (the `kid` JWT header). */
  keyId: string
  /** Apple Team ID (the JWT `iss` claim). */
  teamId: string
  /** APNs topic — the app bundle id. */
  topic: string
  /** Which APNs host to target. */
  environment: 'sandbox' | 'production'
}

/** Google FCM credentials, already decrypted. */
export interface FcmCredentials {
  /**
   * Raw Firebase service-account JSON string. Parsed internally to read
   * `project_id`, `client_email`, `private_key`, and `token_uri`.
   */
  serviceAccountJson: string
}

/** The notification content to deliver, platform-agnostic. */
export interface PushPayload {
  title: string
  body: string
  /** Optional badge count (source of truth is the caller). */
  badge?: number
  /** Arbitrary string→string data carried alongside the alert (deep links). */
  data?: Record<string, string>
  /** Coalescing id (APNs collapse-id / FCM collapse_key). */
  collapseId?: string
}

/** A single device to deliver to. */
export interface PushTarget {
  /** The native APNs/FCM device token (not an Expo token). */
  token: string
}

/** The outcome of a single delivery attempt. */
export interface PushResult {
  /** True when the provider accepted the notification. */
  ok: boolean
  /** HTTP status from the provider (0 if the request never completed). */
  status: number
  /** Provider message id when available (APNs apns-id / FCM message name). */
  messageId?: string
  /** Provider error reason when not ok. */
  error?: string
  /**
   * True when the token is permanently invalid and should be pruned from the
   * registry (APNs Unregistered/BadDeviceToken, FCM UNREGISTERED/INVALID).
   */
  deadToken: boolean
}
