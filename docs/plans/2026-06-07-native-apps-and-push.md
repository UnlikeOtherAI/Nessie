# Native Apps + Self-Operated Push — Plan

Status: **in progress** (updated 2026-08-11). Bringing Nessie to phones and
desktops as real native apps, with a push-notification server we build and
operate ourselves (no third-party push relay).

## Goals

- Native **iOS** and **Android** apps (React Native / Expo).
- Native **macOS**, **Windows**, and **Linux** desktop apps (Tauri, wrapping
  the existing `admin/` web build).
- **Our own push server** — sends directly to APNs and FCM from a service we
  operate; no Expo Push, no third-party relay.
- Reuse Nessie's non-visual core (API client, query hooks, auth, schemas)
  across web, desktop, and mobile.

## Non-goals (for now)

- Porting the existing `admin/` React-DOM components to React Native — the
  mobile UI is a fresh build (see "Tradeoff" below).
- A Linux port of the legacy `macos/` SwiftUI voice/orchestrator app; that app
  remains a separate macOS-only product surface.
- Linux package formats beyond the initial Ubuntu x86_64 `.deb` and AppImage
  release targets.
- Apple Watch / widgets and voice (the `macos/` voice app stays separate).
- Offline-first sync. v1 is online-first with graceful reconnect.

## Locked decisions

| Area | Decision | Why |
| --- | --- | --- |
| Mobile | React Native via **Expo** (managed) | Real native feel; EAS build/submit; OTA updates |
| Desktop | **Tauri** over the `admin/` web build | Tiny binaries, native OS notifications, reuse the web UI as-is |
| Push | **Self-operated push server** → APNs + FCM directly | Full control, no per-message third-party dependency, multi-tenant routing |
| Hosting | Push gateway is **central, operated by us** | APNs/FCM creds + the published app belong to us, not to each self-hosted org |
| Platforms | iOS + Android + macOS + Windows + Linux | Linux begins with Ubuntu x86_64 |

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
desktop/           NEW       Tauri shell wrapping the admin web build — mac + win + Linux
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

The hosted deployment currently sends directly from Nessie's API/worker through
`@nessie/push`: the API stores platform credentials in its encrypted secret
store, while the worker selects recipients and opens the APNs/FCM connection.
That is the operative, fully in-house path — no Expo Push or other message relay
receives notification content or device tokens. The separately deployable
`push-gateway/` remains an optional central boundary for future self-hosted
instances; it must preserve the same payload, credential, tenant, and dead-token
contracts rather than becoming a second delivery implementation.

### Topology

```
 message / @mention / DM / approval / agent-done
        │  (Postgres pubsub event)
        ▼
 worker push-dispatch ── resolves recipients → their device tokens
        │  decrypts platform credential only in server process
        ▼
 @nessie/push ── APNs (HTTP/2 + .p8 JWT) ──► iPhones
              └─ FCM  (v1 API + service acct) ─► Android
```

- The **worker** decides *who* should be notified and *what the payload is*
  (this needs tenant/RBAC context, so it stays inside each instance).
- The **direct server sender** is dumb fan-out: "deliver this payload to these
  tokens via APNs/FCM." Recipient selection and tenant policy stay in the
  worker; decrypted secret bytes never leave the server process.
- If the optional gateway is enabled for a self-hosted topology, it is an
  authenticated forwarding boundary, not a client-facing push service.

### Device-token registry

New table (per-instance, in each Nessie DB). A token has one current owner;
the worker additionally filters that owner by its organization before delivery:

```
device_tokens
  id              uuid pk
  organization_id uuid   (tenant scope)
  user_id         uuid
  platform        enum(ios, android)
  token           text   (the *native* APNs/FCM token, not an Expo token)
  app_version     text
  apns_environment enum(sandbox, production), nullable for Android
  registration_version bigint (server-issued global ownership generation)
  inactive_at      timestamptz (logout tombstone; never delivered)
  last_seen_at    timestamptz
  created_at      timestamptz
  unique(token)
```

Endpoints (in `api/`):

- `POST /api/devices` — register/refresh `{ platform, token, appVersion,
  apnsEnvironment? }`; iOS supplies the host selected by its signed build.
  A native token represents one installation, so registration transfers it to
  the current user and organization rather than retaining a former login. The
  server signs every access session with a strictly increasing global ownership
  generation, then rejects a late former-session request — even from a
  different account — rather than restoring stale ownership.
- `DELETE /api/devices/:token` — unregister (logout / token invalidated).
  This tombstones the installation with a newer server generation instead of
  deleting it, so an in-flight former-session registration remains rejected.

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
- **Coalesce** by channel feed or message-level reply conversation
  (`apns-collapse-id` / FCM collapse key) so a busy conversation doesn't spam
  without replacing a different reply conversation.
- Carry a **deep link** to the message's reply conversation so a tap opens the
  exact channel feed item or reply thread.
- **Badge** = the recipient's authoritative total: unread channel messages
  plus visible assigned-work and published-knowledge attention. The server is
  the source of truth and pushes an absolute total in every native/browser
  payload; a task or knowledge delivery must never overwrite channel unread
  state with a subtotal. Reply read cursors are per root conversation, not per
  container thread, so reading one reply panel never clears another.
- Respect **mute/quiet-hours** (per channel + per user) — evaluated in the
  worker before dispatch.
- **Silent pushes** to nudge a foregrounded-soon app to refresh unread state.

### Security & multi-tenant isolation

- Per-instance gateway API key; the gateway never trusts a token→user mapping it
  did not receive over an authenticated call.
- Device tokens are `organization_id`-scoped; the worker filters every native
  fan-out by both organization and recipient user, so a multi-workspace user
  never receives another workspace's notification on a shared device.
- iOS records the APNs environment of the signed build with its token. The
  worker uses that environment for each send, so sandbox development builds
  and TestFlight/production builds can coexist against the same `.p8` key.
- `.p8` / FCM service-account secrets live only in the platform's encrypted
  server-side secret store, never in client apps or organization configs.
- The direct sender is stateless with respect to tenant content — it stores no
  messages, only does scoped fan-out and reports dead tokens for pruning.

## Push credentials — super-user upload (admin)

The gateway needs Apple/Google credentials. These are **platform-global** — one
Apple key + one FCM project for the single published app — so they are NOT a
per-tenant setting. They are managed by a **platform operator** through a
dedicated super-user surface, gated to a new **super-admin** role that sits
*above* the per-organization `owner` role (when this was written "superuser"
=== org `owner`, which is per-tenant and therefore the wrong gate for global
creds). **2026-08-16:** `User.superAdmin` is now the named instance-wide role
generally, not only for push credentials — the other deployment-wide surfaces
that were leaning on org `owner` (ops health, MCP public-store review,
instance-global catalog rows) moved onto it.

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
- A **"Send test to this iPhone"** action delivers directly to the requesting
  operator's newest registered iOS device in the current workspace, so it
  verifies the exact server → APNs → device chain before shipping.

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
- Build targets: macOS (universal), Windows (MSI/NSIS), and Linux (Ubuntu
  x86_64 `.deb` + AppImage). Code-signing + notarization (Apple),
  Authenticode (Windows), and checksums/signatures for Linux artifacts.

### Linux desktop discovery scope (2026-09-01)

Linux uses the existing `desktop/` Tauri shell and therefore the same `admin/`
artifact, API contracts, SSE notification path, and `nessie://` callback as the
other desktop shells. It does **not** add a Linux-specific UI or port the
macOS-only SwiftUI voice/orchestrator app.

The first supported release target is **Ubuntu x86_64**. The release artifacts
will be a signed-checksum `.deb` for the supported package-managed install path
and an AppImage for a portable direct-download path. RPM, Flatpak, Snap, AUR,
other distributions, ARM, and automatic updates are follow-on decisions once
the Ubuntu release path has passed smoke testing.

The development host is the existing Ubuntu 26.04 WSL 2 / WSLg environment.
It has Node 20.20.2, pnpm 9.15.9, WebKitGTK 4.1, and working X11/Wayland display
variables, but no Rust toolchain. Before a first build, provision Rust and the
Tauri Linux prerequisites for the distribution: `build-essential`, `curl`,
`wget`, `file`, `libxdo-dev`, `libssl-dev`,
`libayatana-appindicator3-dev`, and `librsvg2-dev` (plus the installed
`libwebkit2gtk-4.1-dev`). Keep those host dependencies outside the repository.

Implementation and release work is deliberately staged:

1. **Linux development baseline** — install the missing host toolchain, run
   `tauri dev` through WSLg against `pnpm dev`, and prove the WebKitGTK window
   can load the local admin and complete a normal API request.
2. **Cross-platform shell audit** — remove the current macOS/Windows-only
   single-instance guard only after checking the plugin's Linux behavior; test
   deep-link activation, notifications, title-bar behavior, and external URL
   opening under WebKitGTK.
3. **Packaging and install** — make Linux bundle targets explicit in
   `tauri.conf.json`; build a `.deb` and AppImage on Ubuntu; install each in a
   clean Ubuntu environment; verify launch, `nessie://` callback handling, and
   native notification delivery.
4. **Release quality** — add a Linux CI build that retains both artifacts,
   publishes SHA-256 checksums and signatures, and runs an install/launch smoke
   test. A signed package is not a substitute for an install-path smoke test.

Linux support is ready for a release candidate only when the two artifacts are
created from a lint-gated build, install and launch on the supported Ubuntu
version, load the production admin bundle, authenticate through the browser and
deep link, and display a native notification from the existing SSE path. A WSLg
run validates development ergonomics but does not by itself replace a clean
Ubuntu installation test.

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
  rootMessageId?, organizationId, contentSnippet (≤140 chars), mentionUserIds[] }`.
  New jobs target `/channels/:channelId/threads/:threadId/replies/:rootMessageId`
  (a top-level message is its own root), so native, web, and in-app taps open
  the notified conversation rather than the channel default. Interactive
  agent replies use the same consumer with `recipientUserIds[]` instead of an
  author id, so the person who asked receives the completed reply even after
  leaving the app. Enqueue helper: `enqueuePushDispatch` in
  `api/src/queue/pgqueue.ts`.
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

### Web + desktop notification consumer — implemented (2026-06-10)

The in-app + native notification consumer for the `admin/` bundle is live, so
both the **web admin** and the **desktop (Tauri) app** (which loads the same
bundle) notify on new messages with **no APNs/FCM** — they ride the per-user SSE
stream directly:

- `admin/src/facades/notifications/useMessageNotifications.ts` subscribes to the
  shared per-user event stream (`admin/src/facades/realtime/event-stream.ts`,
  which owns the single fetch to `GET /api/events/stream` — bearer token,
  `Last-Event-ID` resume, the jittered reconnect policy from
  `facades/threads/stream-retry.ts`, and the shared frame reader in
  `admin/src/lib/sse.ts`). It used to open that connection itself, alongside a
  second one from the alerts bell; the route derives the subscription entirely
  server-side, so the two sockets carried identical bytes and each discarded the
  other's events. On each newly created message (`message.new` or an agent
  `message.reply`) it fires a native
  `Notification` (when permission is granted) **and** an in-app toast
  (`admin/src/providers/NotificationsProvider.tsx`), deep-linking to
  `/channels/:channelId` on click. Wired into `AdminShellLayout`.
- Suppression rules: never notify for the recipient's **own** message
  (`authorUserId === me`) and never for the **exact channel feed or reply
  conversation currently being viewed** (container `threadId` plus a matching
  nullable reply-root id while the window is focused and visible). A foreground
  client elsewhere in Nessie still receives its in-app banner; only that exact
  conversation suppresses it. Backlog replay events
  (ts < connect time) are ignored; notified message ids are de-duplicated.
- To make those rules reliable the `message.new` realtime event now carries
  `channelId` + `authorUserId` (optional fields on `MessageNewEventSchema` in
  `@nessie/schemas`), populated by every publisher (`api/src/routes/threads.ts`
  for human messages — which also sets `authorUserId` — and the worker
  publishers in `pa-tools`/`orchestrate`/`execute`/`mailbox`, which set
  `channelId`). Verified live: a message posted by another user lands a toast on
  the recipient's stream; the recipient's own message does not.
- The desktop app's native OS notifications use this exact path: the shared
  admin controller calls the Tauri notification bridge, which emits a macOS or
  Windows system alert and returns the click to the same route mapper. Desktop
  therefore needs no separate notification SSE stream. Mobile
  (backgrounded/closed) still requires the APNs/FCM pipeline above.

## Accounts & infra checklist

- [ ] Apple Developer Program ($99/yr): App ID + Push entitlement, APNs `.p8`
      key, TestFlight.
- [ ] Google Play ($25 once) + **Firebase project**: FCM v1 + `google-services.json`.
- [ ] Expo / **EAS** account: cloud builds + store submission.
- [ ] Tauri signing: Apple Developer ID cert + notarization for the
      executor-capable direct build; Apple Distribution + Mac Installer
      Distribution credentials and a Mac App Store Connect profile for the
      sandboxed TestFlight build; Windows Authenticode cert.
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
   SSE, signed mac + win builds. The Mac App Store/TestFlight configuration is
   a sandboxed shell build; it omits the packaged executor until that child
   process and its user-selected workspace access have a reviewed sandbox
   design. Developer ID distribution remains the executor-capable build.
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
