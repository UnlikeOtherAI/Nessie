# Nessie Web Push (browser notifications)

Authoritative guide for browser Web Push — notifications delivered to a user's
browser (or installed PWA) from the admin SPA. Web Push is a **second push
transport that runs alongside** the existing native APNs/FCM device push, not a
replacement: the same worker dispatch pipeline now fans a notification out to
both native device tokens and browser subscriptions.

## Overview

When a channel message is dispatched, the worker's `handlePushDispatch`
pipeline resolves recipients (channel members minus the author, minus muted /
push-disabled / focus-mode / quiet-hours users), then delivers the notification
over every configured transport. Incoming calls use the same delivery core via
the single-recipient `call.ring-dispatch` job, with a deliberately different
surface rule: a call ring reaches every device even when one device is already
viewing the channel. Focus mode is stored in the user's server-side preferences,
so it applies to every registered device immediately at delivery; active clients
also refresh the shared preference while visible. Recipients who
were directly @mentioned in the message get distinct mention framing —
`<author> mentioned you in <channel>` as the title instead of the channel label
— while unmentioned members keep the standard framing. A muted channel
suppresses the push even for mentioned users, but the durable `UserAlert` row
(bell badge) is still created: a mention is never lost, just quiet.

- **Native** — APNs (Apple) and FCM (Android) via stored `DeviceToken` rows.
- **Browser** — Web Push via stored `WebPushSubscription` rows, encrypted and
  signed entirely in-process by `@nessie/push`.

The browser path uses the standard W3C Push API + Service Worker stack:

| Stage | Where | Responsibility |
|-------|-------|----------------|
| Subscribe | Admin SPA (`/settings/notifications`) | User opts in; browser mints a `PushSubscription` and the SPA registers it with the API |
| Store | API (`/api/push/web/*`) | Persists/removes the user's subscription, scoped to the caller |
| Encrypt + sign | Worker (`@nessie/push`) | Builds an RFC 8291 encrypted payload and an RFC 8292 VAPID JWT |
| Relay | Browser's push service | The endpoint URL in the subscription (Apple/Google/Mozilla-operated) |
| Display | Service worker (`admin/public/sw.js`) | Receives the `push` event, shows the notification, opens the deep link on click |

Web Push is **enabled only when all three VAPID settings are configured**
(`config.webPush.{publicKey,privateKey,subject}`). With any missing, the API
reports `enabled: false`, the SPA hides the opt-in, and the worker simply skips
the browser fan-out.

## Standards and crypto

`@nessie/push` implements the full Web Push spec stack with **zero third-party
dependencies** — Node's built-in `crypto` only:

- **Payload encryption — RFC 8291.** Per message: an ephemeral ECDH P-256 key
  agreement against the subscription's `p256dh` public key, HKDF-SHA256 to
  derive the content-encryption key and nonce, then AES-128-GCM. The ciphertext
  is framed with the `aes128gcm` content coding of **RFC 8188**
  (`Content-Encoding: aes128gcm`).
- **Sender authentication — RFC 8292 (VAPID).** Each request carries a single
  `Authorization: vapid t=<ES256 JWT>, k=<base64url public key>` header. The
  JWT is ES256-signed with the instance private key; its `aud` is the push
  service origin, `sub` is the configured subject, and it carries a short
  expiry.

Relevant source: `packages/push/src/webpush.ts` (`sendWebPush`,
`WebPushClient`), `packages/push/src/webpush-crypto.ts` (RFC 8291/8188), and
`packages/push/src/vapid.ts` (RFC 8292 JWT). The keys interoperate byte-for-byte
with the conventional `web-push` library / browser formats.

## Configuration

One VAPID key pair per Nessie instance. The public key is served to browsers
(safe to expose); the private key signs every VAPID JWT and **must stay secret**.

| Setting | Env var | Value |
|---------|---------|-------|
| VAPID public key | `NESSIE_WEBPUSH_PUBLIC_KEY` | base64url of the 65-byte uncompressed P-256 point; served to browsers as the subscription `applicationServerKey` |
| VAPID private key | `NESSIE_WEBPUSH_PRIVATE_KEY` | base64url of the 32-byte P-256 private scalar; secret |
| VAPID subject | `NESSIE_WEBPUSH_SUBJECT` | a `mailto:` or `https:` URI identifying the sender (operator contact) |

All three map into `config.webPush` (`packages/config`). Web Push is active only
when all three are non-empty.

### Generating keys

```sh
node scripts/generate-vapid-keys.mjs
```

It prints the three `NESSIE_WEBPUSH_*` env lines (with a placeholder
`mailto:` subject to edit). Add them to your `.env` / deployment secrets. The
same key pair must be used by both the API (to advertise the public key) and the
worker (to sign) — they read the same config.

## Database

A new `WebPushSubscription` model (`web_push_subscriptions` table) stores one row
per browser subscription:

| Column | Notes |
|--------|-------|
| `id` | UUID primary key |
| `organization_id` | tenant scope (indexed) |
| `user_id` | owning user (indexed) |
| `endpoint` | push-service URL the worker POSTs to |
| `p256dh` | subscription public key (RFC 8291 ECDH peer) |
| `auth` | subscription auth secret (RFC 8291 HKDF salt input) |
| `user_agent` | best-effort UA string, clamped to 512 chars |
| `last_seen_at` | refreshed on each (re)subscribe |
| `created_at` | first seen |

Uniqueness is `(user_id, endpoint)`, so re-subscribing is an idempotent upsert
and a user can only ever touch their own row.

The `PushProvider` enum gains a `webpush` member alongside `apns` and `fcm`;
every browser delivery attempt is logged to `push_deliveries` with
`provider = 'webpush'`.

## API endpoints

All three are authenticated and scoped to the calling user within their tenant
(`api/src/routes/web-push.ts`).

| Method + path | Body | Behaviour |
|---------------|------|-----------|
| `GET /api/push/web/config` | — | Returns `{ enabled, publicKey }`. `publicKey` is `null` when web push is off. The SPA reads this before showing the opt-in. |
| `POST /api/push/web/subscribe` | the browser's `PushSubscription.toJSON()` (`{ endpoint, keys: { p256dh, auth } }`) | Validates the endpoint (`https` only, SSRF-guarded — see Security) and the key sizes (65-byte `p256dh`, 16-byte `auth`), then upserts the caller's subscription by `(userId, endpoint)`, records the UA, and evicts the caller's oldest rows beyond the per-user cap. Returns `201` with the stored record. |
| `POST /api/push/web/unsubscribe` | `{ endpoint }` | Deletes the caller's matching subscription. Idempotent (missing row is not an error); returns `204`. A user can never delete another user's subscription. |

## Worker delivery

`worker/src/control/web-push-delivery.ts` (`deliverWebPush`) is the browser
fan-out invoked from `handlePushDispatch` for the resolved recipient set:

1. Load every `WebPushSubscription` for the recipient user IDs.
2. Build the payload from the same native notification (title/body/data) and add
   a `data.url` deep link (`/channels/<channelId>`) the service worker opens on
   click.
3. For each subscription, call `sendWebPush` (RFC 8291 encrypt + RFC 8292 sign).
4. Log each attempt to `push_deliveries` as `provider: 'webpush'`
   (`sent` / `failed` / `dead`).
5. **Auto-prune dead subscriptions.** When the push service returns `404` or
   `410 Gone`, the subscription is deleted so it is never retried.

The path never throws out of its loop — one failed endpoint cannot abort the
rest — and the Prisma surface, sender, and SSRF guard are injected so it is
unit-testable without a live database or network
(`worker/test/web-push-delivery.test.ts`).

### Incoming calls

Calls use two durable worker topics, each scoped to exactly one current invitee:

- `call.ring-dispatch` rechecks active organization membership, channel
  membership, the call's still-ringing state and expiry, and the recipient's
  `pushIncomingCalls` preference before sending. Focus mode and quiet hours
  suppress both the ring and the later missed-call attention push.
- `call.ring-cancel` bypasses those preference checks because it is silent
  protocol cleanup for a ring that might already be visible on another device.

Ring and cancel payloads carry `version: "1"`, `kind`, `callId`, `revision`,
and an internal channel path. This makes unrecognised future payloads safe for
older clients to ignore. Rings set native high priority and the
`incoming-calls` category/channel; cancel payloads share the call collapse id.

Native payloads deliberately contain **no meeting URI** and no action token.
They carry only the internal path
`/channels/:channelId?incomingCall=:callId`, preserving the mobile shell's
internal-path-only trust boundary. Browser Web Push is RFC 8291 encrypted, so
its payload may additionally carry the meeting URI and two compact signed
response tokens (accept and decline). A token binds the call id, recipient user
id, action, expiry, and call revision. `POST /api/calls/:callId/respond` is the
only unauthenticated call endpoint; it consumes a still-ringing invite exactly
once and returns `204` with no call record or meeting URI. The normal call
routes remain bearer-authenticated.

The service worker and native-shell handling for this versioned call protocol
ship in later call-delivery slices. Until then, server fan-out is safe to run:
old clients receive ordinary payload data and do not gain an external URL path.

## Security

- **SSRF.** A subscription `endpoint` is client-supplied and becomes an outbound
  POST target in the worker. Every endpoint passes the shared SSRF guard
  (`assertSafeUrl` from `@nessie/runtime`) — at subscribe time (reject with 400)
  and again before each send (skip the POST), the latter closing the
  DNS-rebinding window where a stored host is later repointed at an internal
  address. A send-time guard failure is a non-dead failure, not a prune: the
  guard throws the same error for a blocked host and a transient DNS hiccup, so
  pruning on it could destroy a valid subscription. `https` is required; real
  push services are always `https`.
- **Input bounds.** `endpoint`, `p256dh`, and `auth` are length- and
  format-validated at subscribe time, so structurally-invalid subscriptions
  (which could never be encrypted for) are rejected rather than failing forever.
- **Per-user cap.** A user keeps at most a small number of subscriptions
  (`MAX_SUBSCRIPTIONS_PER_USER`); the oldest are evicted, bounding table growth
  and worker fan-out amplification.
- **Tenant isolation.** Subscribe/unsubscribe are scoped to the calling
  `userId` + `organizationId`; the delivery query is org-scoped too. A user can
  never read, clobber, or delete another user's subscription.
- **VAPID key storage.** Unlike the APNs/FCM secrets (encrypted `PushSecretStore`),
  the single instance-wide VAPID key pair lives in env/config. This is a
  deliberate choice: it is one non-tenant key the worker needs at process start,
  not a per-tenant secret. If per-tenant VAPID keys are ever needed, move them
  into the secret store.
- **Shared browsers.** Subscriptions are keyed by `(userId, endpoint)`, so two
  users on one browser get separate rows. A user who does not toggle web push
  off before another signs in leaves a row that keeps delivering to that browser
  until they disable it; the per-user cap and dead-subscription pruning bound the
  blast radius.

## Admin UI

- **Service worker** — `admin/public/sw.js` handles the `push` event
  (`showNotification` with the payload title/body/icon and a per-channel `tag`)
  and `notificationclick` (focus an existing tab on the deep-link URL or open a
  new one).
- **Web app manifest** — `admin/public/manifest.webmanifest` (standalone
  display, icons) makes the admin installable as a PWA, which is required for
  Web Push on iOS.
- **Opt-in toggle** — a "Browser notifications" control on
  `/settings/notifications`. It reads `GET /api/push/web/config`, and on enable
  (from a user gesture) registers the service worker, calls
  `Notification.requestPermission()`, subscribes via the Push API with the
  instance public key, and POSTs the subscription to
  `/api/push/web/subscribe`. Disabling unsubscribes locally and calls
  `/api/push/web/unsubscribe`. Browser helpers live in
  `admin/src/lib/web-push.ts`; the API hooks in
  `admin/src/facades/web-push/hooks.ts`.

## Local development

1. Generate keys with `node scripts/generate-vapid-keys.mjs` and set the three
   `NESSIE_WEBPUSH_*` vars in your local env.
2. Run `pnpm dev` (API 5454 + admin 5455). The admin dev origin
   `http://localhost:5455` is a **secure context exemption**, so the Push API
   and service worker work without TLS in local dev.
3. Open `/settings/notifications`, enable **Browser notifications**, accept the
   permission prompt, and send a channel message to a different user to see the
   notification.

Rebuild the worker (`pnpm --filter @nessie/worker build`) after worker changes —
in local mode the API runs the worker embedded from its built `dist`.

## Browser and iOS caveats

- **HTTPS required.** Service workers and the Push API only run in a secure
  context. Production is HTTPS via Caddy; `localhost` is exempt for dev.
- **Safari on macOS.** Open `https://app.nessie.works/settings/notifications`,
  keep the Nessie push preferences enabled, turn on **Browser notifications**,
  and allow the `app.nessie.works` prompt in Safari. Nessie then stores that
  Safari profile's subscription and the worker sends its encrypted Web Push
  payload to Apple's browser push service. Each Safari profile and device needs
  its own opt-in.
- **Badges.** An active Nessie web app mirrors the same authoritative attention
  total onto the browser's Badging API when available. The service worker also
  applies the absolute `badge` supplied with a Web Push payload, so an
  installed Home Screen Nessie app can update its icon while it is backgrounded.
  On Apple platforms this requires notification permission; regular Safari tabs
  do not expose an app-icon badge, whereas installed web apps do.
- **iOS needs an installed PWA.** Safari on iOS/iPadOS delivers Web Push **only
  to a Home Screen-installed PWA** (Add to Home Screen), and only on iOS
  16.4+. A regular Safari tab cannot subscribe. The web app manifest exists to
  make this install path work.
- **User gesture required.** Browsers only allow the permission prompt from a
  user interaction, so the opt-in must be triggered by the toggle, not on load.
- **Dead subscriptions self-heal.** Subscriptions expire or are revoked by the
  browser; the worker prunes any the push service reports as `404`/`410`, so no
  manual cleanup is needed.
</content>
</invoke>
