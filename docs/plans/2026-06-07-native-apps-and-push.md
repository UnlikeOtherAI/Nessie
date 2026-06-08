# Native Apps + Self-Operated Push — Plan

Status: **proposed** (2026-06-07). Bringing Nessie to phones and desktops as
real native apps, with a push-notification server we build and operate
ourselves (no third-party push relay).

## Goals

- Native **iOS** and **Android** apps (React Native / Expo).
- Native **macOS** and **Windows** desktop apps (Tauri, wrapping the existing
  `admin/` web build).
- **Our own push server** — sends directly to APNs and FCM from a service we
  operate; no Expo Push, no third-party relay.
- Reuse Nessie's non-visual core (API client, query hooks, auth, schemas)
  across web, desktop, and mobile.

## Non-goals (for now)

- Porting the existing `admin/` React-DOM components to React Native — the
  mobile UI is a fresh build (see "Tradeoff" below).
- Linux desktop, Apple Watch / widgets, voice (the `macos/` voice app stays
  separate).
- Offline-first sync. v1 is online-first with graceful reconnect.

## Locked decisions

| Area | Decision | Why |
| --- | --- | --- |
| Mobile | React Native via **Expo** (managed) | Real native feel; EAS build/submit; OTA updates |
| Desktop | **Tauri** over the `admin/` web build | Tiny binaries, native OS notifications, reuse the web UI as-is |
| Push | **Self-operated push server** → APNs + FCM directly | Full control, no per-message third-party dependency, multi-tenant routing |
| Hosting | Push gateway is **central, operated by us** | APNs/FCM creds + the published app belong to us, not to each self-hosted org |
| Platforms | iOS + Android + macOS + Windows | — |

## The tradeoff we are accepting (RN vs a web wrapper)

React Native renders with native primitives (`View`/`Text`), not the DOM. The
existing `admin/` components (Tailwind + `div`/`span`) **do not port**. The
mobile UI is rebuilt. What reuses cleanly is everything non-visual:

- `@nessie/schemas` (pure TS) — already shared.
- The **API client** (`fetch`-based) — platform-agnostic.
- The **TanStack Query** hooks / facades — platform-agnostic.
- **OIDC / PKCE** auth logic.

Desktop is the opposite: Tauri runs the existing web `admin/` build verbatim, so
desktop reuses ~100% of the current UI and needs no rebuild.

## Architecture

```
packages/
  schemas/         (exists)  shared zod + types
  client-core/     NEW       api client + query hooks + auth, extracted from admin/
admin/             (exists)  web UI  ──►  also the payload for the desktop shell
mobile/            NEW       Expo (RN) app — iOS + Android
desktop/           NEW       Tauri shell wrapping the admin web build — mac + win
api/               (exists)  + device-token registry endpoints
worker/            (exists)  + push dispatch off the Postgres pubsub queue
push-gateway/      NEW       standalone central service: APNs + FCM senders
```

Two reuse axes:

- **Desktop** reuses the web UI (Tauri loads `admin/`'s build); only a thin
  native layer (OS notifications, deep links, auto-update) is new.
- **Mobile** reuses the *logic* (`client-core`) but builds a new RN UI.

### Realtime vs push — they are different systems

Nessie's realtime is **SSE** (`text/event-stream`) over the Postgres pubsub
queue. SSE drives the live UI while the app is in the foreground. The OS
suspends SSE when the app is backgrounded, so **push is the only way to notify a
backgrounded/closed app**. Desktop apps run foreground/tray, so desktop
"notifications" come from SSE → native OS notification and need **no APNs/FCM**.
Only the mobile apps need true background push.

Foreground clients should use one user-scoped connection:

- `GET /api/events/stream` authenticates the session, resolves the user's
  current channel/DM memberships, subscribes to those channel realtime scopes,
  and fans message, approval, and agent events over one `EventSource`.
- Each event is emitted with a monotonic SSE `id:` from `realtime_events`, an
  `event:` name matching the realtime event type, and JSON `data:` matching the
  existing WebSocket event message shape.
- Reconnects send `Last-Event-ID`; the API replays rows with higher ids for the
  user's current channel scopes before live delivery resumes. The replay log is
  pruned opportunistically after 24 hours, so it is for short reconnect gaps,
  not offline sync.
- Memberships are resolved at connect time. Channel joins/leaves take effect on
  reconnect for v1.

## The push server (self-operated)

The centerpiece. One central service we run (`push-gateway/`) that owns the
APNs/FCM credentials and the published app identity, and fans notifications out
to devices. Every Nessie backend — including self-hosted ones — asks the gateway
to deliver; the gateway is the single component that is *not* self-hostable,
because the signing keys and the App Store / Play listing belong to us.

### Topology

```
 message / @mention / DM / approval / agent-done
        │  (Postgres pubsub event)
        ▼
 worker push-dispatch ── resolves recipients → their device tokens
        │  authenticated HTTPS (per-instance API key)
        ▼
 push-gateway ── APNs (HTTP/2 + .p8 JWT) ──► iPhones
              └─ FCM  (v1 API + service acct) ─► Android
```

- The **worker** decides *who* should be notified and *what the payload is*
  (this needs tenant/RBAC context, so it stays inside each instance).
- The **gateway** is dumb fan-out: "deliver this payload to these tokens via
  APNs/FCM." It holds the secrets; it does not need tenant context.
- Self-hosted instances call the gateway over HTTPS with a per-instance key.
  The single-tenant hosted deployment calls the same gateway in-process or over
  localhost.

### Device-token registry

New table (per-instance, in each Nessie DB), `organization_id`-scoped like every
other child table:

```
device_tokens
  id              uuid pk
  organization_id uuid   (tenant scope)
  user_id         uuid
  platform        enum(ios, android)
  token           text   (the *native* APNs/FCM token, not an Expo token)
  app_version     text
  last_seen_at    timestamptz
  created_at      timestamptz
  unique(user_id, token)
```

Endpoints (in `api/`):

- `POST /api/devices` — register/refresh `{ platform, token, appVersion }`.
- `DELETE /api/devices/:token` — unregister (logout / token invalidated).

Token hygiene: APNs/FCM report invalid tokens on send; the gateway returns those
to the worker, which prunes them. Tokens also rotate on reinstall — clients
re-register on every launch.

### Getting *native* tokens out of Expo (bypassing Expo Push)

Because we run our own server, the mobile app must hand us the **raw APNs/FCM
device token**, not an Expo push token:

- `expo-notifications` → `getDevicePushTokenAsync()` returns the native token
  (APNs token on iOS, FCM token on Android). That is what we register and what
  the gateway sends to. (`getExpoPushTokenAsync()` — the Expo Push path — is
  *not* used.)
- iOS still needs the APNs entitlement + the `.p8` key configured in our gateway.
- Android needs the app wired to **our** Firebase project (`google-services.json`)
  so FCM issues tokens our service account can send to.

### Senders

- **APNs**: HTTP/2 to `api.push.apple.com`, **token-based auth** (`.p8` key →
  short-lived ES256 JWT, cached ≤ 20 min). Topic = the app bundle id. Supports
  `apns-collapse-id` (coalescing), priority, and background/silent pushes.
- **FCM**: HTTP v1 API, OAuth via a service-account JWT. Supports collapse keys,
  Android channels, and data-only messages.

### Payload & UX rules

- Notify on: new message in a channel/DM the user is in, `@mention`, DM, approval
  request assigned to the user, agent run finished for the user.
- **Coalesce** by channel (`apns-collapse-id` / FCM collapse key) so a busy
  channel doesn't spam.
- Carry a **deep link** (`nessie://channels/:id?msg=:id`) so a tap opens the
  exact thread.
- **Badge** = unread count; server is source of truth, pushed in the payload.
- Respect **mute/quiet-hours** (per channel + per user) — evaluated in the
  worker before dispatch.
- **Silent pushes** to nudge a foregrounded-soon app to refresh unread state.

### Security & multi-tenant isolation

- Per-instance gateway API key; the gateway never trusts a token→user mapping it
  did not receive over an authenticated call.
- Device tokens are `organization_id`-scoped; the worker only ever sends a
  user's own tokens.
- `.p8` / FCM service-account secrets live only in the gateway (reuse the
  existing prod secret-store pattern), never in client apps or instance configs.
- Gateway is stateless w.r.t. tenant data — it stores no messages, only does
  authenticated fan-out and reports back dead tokens.

## Push credentials — super-user upload (admin)

The gateway needs Apple/Google credentials. These are **platform-global** — one
Apple key + one FCM project for the single published app — so they are NOT a
per-tenant setting. They are managed by a **platform operator** through a
dedicated super-user surface, gated to a new **super-admin** role that sits
*above* the per-organization `owner` role (today "superuser" === org `owner`,
which is per-tenant and therefore the wrong gate for global creds).

### What the operator uploads — "exactly what Apple/Google give you"

- **Google FCM**: a single file — the Firebase **service-account JSON**
  (Project Settings → Service accounts → Generate new private key). It already
  contains `project_id`, `client_email`, `private_key`. Drop it in; nothing else
  to enter. (The legacy server-key string is deprecated — v1 + service account
  only.)
- **Apple APNs (token auth, preferred)**: the `.p8` auth key file, plus three
  values Apple deliberately keeps *outside* the file:
  - **Key ID** — auto-extracted from the filename `AuthKey_<KEYID>.p8`.
  - **Team ID** — from Apple Developer membership.
  - **Bundle ID / topic** + **environment** (sandbox vs production).

  So FCM is one file; APNs is the `.p8` plus three tiny fields (one auto-filled).
  Certificate-based `.p12`/`.cer` push is intentionally not supported — `.p8`
  token auth is one key, no yearly expiry, all environments.

### Validation & test (so "just put them in" really works)

- On `.p8` upload: parse as a PKCS#8 EC key and mint a throwaway ES256 JWT to
  prove it signs; reject otherwise.
- On FCM JSON upload: parse, assert `type: "service_account"` and the required
  fields, and do a token exchange to prove the account is live.
- A **"Send test push"** action delivers to a chosen registered device so the
  operator confirms the whole chain before shipping.

### Storage & UX

- Encrypt at rest with the existing **SecretStore** pattern
  (`createPgSecretStore`, AES-256-GCM; see `api/src/services/mcp-oauth-secret-store.ts`),
  under stable refs (e.g. `push_apns`, `push_fcm`).
- **Write-only**: the browser uploads the file/fields; the API never returns the
  secret bytes. The UI shows only metadata — configured ✓, Key ID/Team ID/topic,
  FCM project id, last-updated, last successful send — plus replace / delete /
  test actions.
- Audit every change (who uploaded/replaced/deleted) via the existing audit log.

### Surface & endpoints (platform-scoped, super-admin only)

- A new **super-admin** role + a platform-operator admin section (not the
  per-tenant admin menu). Visible only to that role.
- `PUT /api/platform/push/apns` (multipart: `.p8` + key id / team id / topic /
  env), `PUT /api/platform/push/fcm` (multipart: service-account JSON),
  `GET /api/platform/push/status` (metadata only), `POST /api/platform/push/test`,
  `DELETE /api/platform/push/{apns,fcm}`. These configure the central gateway.

## Mobile app (Expo) — scope

- **Auth**: `expo-auth-session` (OIDC + PKCE) → system browser → deep-link
  callback; session stored in `expo-secure-store`.
- **Navigation**: Expo Router — channels list → thread → composer; DMs;
  approvals; settings.
- **Realtime**: SSE client over `client-core` for the foreground live feed.
- **Push**: register native token on launch; handle taps → deep link; badge
  sync; notification channels (Android) / categories (iOS).
- **Reuse**: all data access via `packages/client-core`.

### Phase 1 skeleton — implemented (2026-06-07)

The Expo app skeleton lives in `mobile/` (`@nessie/mobile`, Expo SDK 54, React
Native 0.81.4, Expo Router). It proves the end-to-end path and closes the
device-registration loop:

- **Monorepo wiring**: `mobile/metro.config.js` watches the repo root, resolves
  from both `mobile/node_modules` and the root store, and resolves
  `@nessie/client-core` / `@nessie/schemas` to their TS source (the dev tree has
  no `dist/`), stripping NodeNext `.js` import suffixes. The workspace uses
  `nodeLinker: hoisted` (`pnpm-workspace.yaml`) so Metro gets the flat
  `node_modules` it needs. `npx expo export --platform ios` bundles cleanly
  (1161 modules).
- **Data layer**: `createApiClient({ baseUrl, token })` from `@nessie/client-core`
  wrapped in a TanStack Query provider (`createQueryClient`); `{ baseUrl, token }`
  held in React context and persisted with `expo-secure-store`. PKCE /
  `beginExternalAuth` is intentionally **not** used in the skeleton.
- **Auth**: a Login screen with an editable API base URL (default
  `http://localhost:5554`); email+password → `POST /api/auth/session`, or a Dev
  login button → `GET /api/auth/dev-login`. On launch a stored token is
  validated via `GET /api/auth/me`.
- **Screens** (`/login`, `/(app)/channels`, `/(app)/channels/[id]`): channel
  list (`GET /api/channels`), thread (loads the channel's `defaultThreadId`,
  lists `GET /api/threads/:threadId/messages`, composes via `POST`), logout
  (`DELETE /api/auth/session` + clear secure-store).
- **Device registration**: `expo-notifications.getDevicePushTokenAsync()` (the
  **native** APNs/FCM token, not the Expo token) → `POST /api/devices`, wrapped
  in try/catch so it no-ops on web / Expo Go / simulators. A notification-tap
  listener deep-links to `/(app)/channels/[id]` via the push payload's
  `data.channelId`.

Not yet built (later phases): SSE realtime feed, DMs/approvals/settings screens,
SSO/PKCE browser flow, badges/coalescing, and on-device verification (no
simulator in CI — verified by `tsc --noEmit` + `expo export`).

## Desktop app (Tauri) — scope

- Tauri shell loads the `admin/` production build (same artifact as web).
- Native OS notifications from the SSE stream (Tauri notification API).
- Deep-link / single-instance handling; tray; auto-update (Tauri updater).
- Build targets: macOS (universal) + Windows (MSI/NSIS). Code-signing +
  notarization (Apple) and Authenticode (Windows).

## API / worker changes (per instance)

- `api/`: `device_tokens` table + migration; `POST /api/devices`,
  `DELETE /api/devices/:token`; mute/quiet-hours fields if not already present.
- `worker/`: a **push-dispatch** consumer on the pubsub queue that resolves
  recipients, applies mute/quiet-hours, builds payloads, and calls the gateway;
  prunes tokens the gateway reports dead.

### Push-dispatch wiring — implemented (2026-06-07)

The dispatch loop is live (no standalone gateway yet — the worker calls the
`@nessie/push` senders directly in-process):

- The api enqueues a `push.dispatch` queue job right after the `message.new`
  realtime publish (`api/src/routes/threads.ts`, fire-and-forget; a push failure
  never breaks message posting). Payload (`PushDispatchJobPayloadSchema` in
  `@nessie/schemas`): `{ messageId, authorUserId, channelId, threadId,
  organizationId, contentSnippet (≤140 chars), mentionUserIds[] }`. Enqueue
  helper: `enqueuePushDispatch` in `api/src/queue/pgqueue.ts`.
- The worker consumer (`worker/src/control/push-dispatch.ts`, registered in
  `worker/src/index.ts`) loads the `push_credentials` rows (early-returns if none
  configured), resolves recipients = channel members minus the author
  (`channelMember.findMany` with `userId: { not: authorUserId }`), loads their
  `device_tokens`, decrypts each provider's secret (`mcp_oauth_secret` row via
  `secretRef`, AES-256-GCM with `deriveSecretKey(config.auth.secret)`), and sends
  ios→APNs / android→FCM. `deadToken` results are pruned from `device_tokens`.
- **Mute/quiet-hours is applied**: `PATCH /api/channels/:channelId/notifications`
  updates the caller's own
  `channel_members.muted` flag, and the worker suppresses muted members, users
  with `preferences.pushEnabled === false`, and users currently inside
  `preferences.pushQuietHours` in their IANA timezone.
- The AES-256-GCM crypto now lives in `@nessie/runtime` (`secret-crypto.ts`) so
  both the api secret stores and the worker share one implementation.

## Accounts & infra checklist

- [ ] Apple Developer Program ($99/yr): App ID + Push entitlement, APNs `.p8`
      key, TestFlight.
- [ ] Google Play ($25 once) + **Firebase project**: FCM v1 + `google-services.json`.
- [ ] Expo / **EAS** account: cloud builds + store submission.
- [ ] Tauri signing: Apple Developer ID cert + notarization; Windows
      Authenticode cert.
- [ ] Host the **push-gateway** (small always-on service alongside the Hetzner
      stack) + secret storage for `.p8` / FCM service account.
- [ ] Custom URL scheme `nessie://` + universal links / app links.

## Phases

0. **Extract `packages/client-core`** from `admin/` (api client, query hooks,
   auth). No visible change; unblocks mobile. *Ship first.*
1. **Expo skeleton** — SSO login + channels list → thread → composer against the
   real API, with SSE realtime. Proves the path end-to-end on a device.
2. **Push server v1** — `push-gateway/` (APNs + FCM), `device_tokens` registry +
   endpoints, worker push-dispatch on message/mention/DM/approval; client
   registers token + tap deep-links.
   - **2a. Push-credentials admin** — new super-admin role + platform-operator
     surface to upload the APNs `.p8` (+ Key ID/Team ID/topic/env) and the FCM
     service-account JSON, encrypted via the SecretStore, with validation and a
     "send test push" button. This is buildable early (independent of the RN
     app) and is what makes the gateway configurable.
3. **Desktop (Tauri)** — shell over the `admin/` build, OS notifications from
   SSE, signed mac + win builds.
4. **Polish** — badges, notification UX controls, coalescing, unread sync, store
   submission (TestFlight / Play internal), auto-update.

## Risks / open questions

- **APNs/FCM ops**: token-auth JWT rotation, dead-token pruning, and per-platform
  payload quirks are fiddly — budget for a hardening pass.
- **Self-hosted instances reaching the gateway**: needs outbound HTTPS + a
  provisioned key; document the trust model and what self-hosters opt into.
- **Mobile UI surface**: channels/threads/DMs/approvals is a real app's worth of
  screens — scope each milestone tightly.
- **Background refresh limits**: iOS budgets background work aggressively; rely on
  push + on-foreground refresh rather than background SSE.
- **Code-signing/notarization** for Tauri on both OSes is its own setup cost.

## Definition of done (v1)

A signed iOS + Android app (TestFlight / Play internal) that logs in via SSO,
shows channels/threads/DMs, sends messages, and receives **push from our own
server** for messages/mentions/DMs/approvals with working deep links; plus signed
macOS + Windows Tauri apps with native notifications. CI green; docs updated.
