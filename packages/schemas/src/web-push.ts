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
 * Body for `POST /api/push/web/subscribe` — the JSON form of a browser
 * `PushSubscription` (`subscription.toJSON()`). `keys.p256dh` and `keys.auth`
 * are base64url; `endpoint` is the push-service URL the browser issued.
 */
export const WebPushSubscribeRequestSchema = z.object({
  endpoint: z.string().url(),
  // The browser includes `expirationTime` (usually null); accepted and ignored.
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
})
export type WebPushSubscribeRequest = z.infer<typeof WebPushSubscribeRequestSchema>

/**
 * Body for `POST /api/push/web/unsubscribe` — removes one subscription by its
 * endpoint (the browser knows its own endpoint after `getSubscription()`).
 */
export const WebPushUnsubscribeRequestSchema = z.object({
  endpoint: z.string().url(),
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
