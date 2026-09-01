import { z } from 'zod'

/**
 * Web Push (browser notifications) — type contracts.
 *
 * The admin SPA subscribes through the browser Push API and POSTs the resulting
 * `PushSubscription` to the authenticated `/api/push/web/*` endpoints; the
 * worker fans notifications out to those subscriptions with RFC 8291 encryption
 * and RFC 8292 VAPID. Subscriptions are user-scoped: a caller only ever
 * registers/removes subscriptions for themselves. See `docs/web-push.md`.
 */

/**
 * A push-service endpoint URL: an absolute `https://` URL, length-bounded. Only
 * a structural check here — the SSRF guard (`assertSafeUrl`) rejects private /
 * internal hosts at the route boundary; real push services are always https.
 */
const WebPushEndpointSchema = z
  .string()
  .url()
  .max(2048)
  .startsWith('https://', 'Web Push endpoints must be https')

/**
 * A base64url string that decodes to exactly `bytes`. Length-checked without
 * `Buffer` so the schema stays browser-safe (the admin imports this package):
 * N bytes encode to `ceil(N*4/3)` unpadded base64url characters.
 */
const base64urlOfLength = (bytes: number, label: string) => {
  const encodedLength = Math.ceil((bytes * 4) / 3)
  return z
    .string()
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, `${label} must be base64url`)
    .refine((value) => value.replace(/=+$/, '').length === encodedLength, {
      message: `${label} must be ${bytes} bytes (base64url)`,
    })
}

/**
 * Body for `POST /api/push/web/subscribe` — the JSON form of a browser
 * `PushSubscription` (`subscription.toJSON()`). `keys.p256dh` is the 65-byte
 * uncompressed P-256 public point and `keys.auth` the 16-byte secret, both
 * base64url; `endpoint` is the push-service URL the browser issued. Key sizes
 * are validated here so structurally-invalid subscriptions (which could never
 * be encrypted for) are rejected at subscribe time rather than failing forever.
 */
export const WebPushSubscribeRequestSchema = z.object({
  endpoint: WebPushEndpointSchema,
  // The browser includes `expirationTime` (usually null); accepted and ignored.
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: base64urlOfLength(65, 'p256dh'),
    auth: base64urlOfLength(16, 'auth'),
  }),
})
export type WebPushSubscribeRequest = z.infer<typeof WebPushSubscribeRequestSchema>

/**
 * Body for `POST /api/push/web/unsubscribe` — removes one subscription by its
 * endpoint (the browser knows its own endpoint after `getSubscription()`).
 */
export const WebPushUnsubscribeRequestSchema = z.object({
  endpoint: WebPushEndpointSchema,
})
export type WebPushUnsubscribeRequest = z.infer<typeof WebPushUnsubscribeRequestSchema>

/** A stored Web Push subscription as returned to its owner (keys omitted). */
export const WebPushSubscriptionRecordSchema = z.object({
  id: z.string().uuid(),
  endpoint: z.string().url(),
  lastSeenAt: z.string().min(1),
  createdAt: z.string().min(1),
})
export type WebPushSubscriptionRecord = z.infer<typeof WebPushSubscriptionRecordSchema>

/**
 * Response for `GET /api/push/web/config` — tells the client whether web push
 * is configured on this instance and, if so, the VAPID public key it needs to
 * call `pushManager.subscribe({ applicationServerKey })`.
 */
export const WebPushConfigResponseSchema = z.object({
  enabled: z.boolean(),
  publicKey: z.string().nullable(),
})
export type WebPushConfigResponse = z.infer<typeof WebPushConfigResponseSchema>
