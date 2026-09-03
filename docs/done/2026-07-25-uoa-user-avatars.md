# UOA user avatars in Nessie (2026-07-25)

## Goal

Every human avatar in the admin should show the picture the user actually
manages — the one they set in UnlikeOtherAuthenticator (UOA) — instead of
falling back to a stale provider URL, a Gravatar, or initials.

UOA guarantees an avatar for every user it knows: an uploaded image, a
server-side proxy of the social-provider picture, or a deterministic generated
SVG. It never returns "no avatar" for a known user. Nessie should use that as an
authoritative source, below a user's own Nessie upload and above the two legacy
fallbacks.

## Contract (verified against the live service on 2026-07-25)

`GET https://authentication.unlikeotherai.com/domain/users/:userId/avatar?domain=<UOA_DOMAIN>`

- Auth: `Authorization: Bearer <clientHash>` where
  `clientHash = SHA256(UOA_DOMAIN + UOA_CLIENT_SECRET)` — the same domain-hash
  credential Nessie already mints in `api/src/services/uoa-auth.ts`.
- `:userId` is the **UOA** subject, not the Nessie user id.
- Always `200` + image bytes for a user visible to the domain; a generic `404`
  for unknown or cross-domain ids.
- Response headers: `X-UOA-Avatar-Source: uploaded | provider | generated`,
  `Cache-Control: private, max-age=300` (or `86400` for generated),
  `X-Content-Type-Options: nosniff`, `ETag`.
- Content types: `image/png`, `image/jpeg`, `image/webp` (uploaded/proxied) or
  `image/svg+xml` (generated).

The credential is a server-side secret, so the browser cannot call UOA directly
— the API relays the bytes.

### Team / company avatars are out of scope: they do not exist

The original brief also asked for a team ("company") avatar page backed by
`/org/organisations/:orgId/teams/:teamId/avatar` and
`/domain/teams/:teamId/avatar`. **Those endpoints are not part of the UOA
contract.** Verified on 2026-07-25 against both machine and human sources:

- `GET /api` lists 243 endpoints; the only avatar paths are
  `/domain/users/:userId/avatar` (GET/PUT/DELETE), `/avatar/me` (GET/PUT/DELETE)
  and `/internal/admin/users/:userId/avatar` (GET). No `*/teams/*/avatar` path
  exists, and no `/org/*` endpoint accepts or returns a team avatar.
- `GET /llm` documents a single "User avatars" section whose endpoint table
  contains exactly those three routes.

A second, independent blocker applies to the dual-auth variants regardless:
`/avatar/me` and every `X-UOA-Access-Token` route need the end user's own UOA
access token. Nessie never stores one. `parseUoaSessionExchange`
(`api/src/services/uoa-session.ts`) reads the access token's claims and discards
the token; only the opaque UOA **refresh** credential is persisted, encrypted and
bound to a Nessie refresh-token family (`UoaSessionCredential`,
`api/src/services/refresh-token-uoa.ts`). Spending it out of band would rotate
the credential and break the family binding that
`docs/plans/…-uoa-token-epoch-caller` invariants depend on. The confidential
token-exchange path (`packages/runtime/src/uoa-delegated-identity.ts`) mints a
resource-bound RS256 token for `ai.invoke` / `billing.read` / `token.provision`
— not an end-user access token for org administration.

Nothing in this plan needs either mechanism: the domain-hash route covers every
user, including the signed-in one, so `/avatar/me` is unnecessary.

## Design

### API — one relay route

`GET /api/users/:userId/avatar`

1. `requireActorContext` — any authenticated actor.
2. Resolve the target's UOA subject from `ProductAccountLink` where
   `productSlug = 'nessie'`, scoped to the **actor's** organization. The unique
   `(organizationId, userId, productSlug)` key is the tenancy gate: a caller can
   only resolve subjects for users linked in their own organization.
3. No link (or UOA unconfigured) → `404`, so the client falls through to its
   existing sources. The 404 carries `Cache-Control: private, max-age=300`
   because a deployment without UOA would otherwise re-ask on every mount of
   every avatar.
4. Otherwise fetch UOA with the domain hash and `AbortSignal.timeout(10s)`, and
   relay the bytes with `content-type`, `content-length`,
   `x-content-type-options: nosniff`, `cache-control: private, max-age=300` and
   `content-security-policy: default-src 'none'`.
5. Transport failure / unusable upstream response → `502`.

The upstream content type is **allowlisted** (`image/png`, `image/jpeg`,
`image/webp`, `image/svg+xml`) and the body is capped, so the relay can never
turn into an open proxy for arbitrary content.

`?size=` is deliberately not forwarded: it only changes the width/height
attributes of a generated SVG (the `viewBox` is constant and it is ignored for
raster images), and the admin scales every avatar with CSS. Keeping one URL per
user keeps the browser cache useful across the ~18 surfaces that render the same
person at different sizes.

New service `api/src/services/uoa-avatar.ts` owns the subject lookup and the
transport, with an injectable `fetchImpl` so tests never touch the network —
matching `uoa-session.ts` error discipline (transport failures are a distinct
error type, not a silent null).

### Admin — one chokepoint

`useResolvedAvatarUrl` in `admin/src/components/primitives/UserAvatar.tsx` is
the single place every human avatar resolves through. The precedence becomes:

`avatarAttachmentId` (Nessie upload) → **UOA proxy** → `avatarUrl` (provider) →
`gravatarUrl` → initials.

The proxy is fetched with the existing `useAuthedObjectUrlFromPath` helper
(bearer fetch → blob object URL, revoked on cleanup). A failed fetch resolves to
`null`, which is exactly "absent", so an unlinked user or an unconfigured
deployment degrades to today's behaviour with no special-casing.

The MIME is **not** pinned via `mimeOverride`. UOA serves generated avatars as
`image/svg+xml`, so pinning `image/png` would break them. The bytes are rendered
in `<img>`, which never executes scripts in an SVG document, and the relay
already allowlists the content type server-side — the chokepoint that actually
matters.

Resolution needs the user's id, so `userId` moves into `AvatarSources`. It was
previously doing double duty as the presence/status badge trigger; badges are
now gated on `showPresence`/`showStatus` instead, so threading an id through the
remaining call sites upgrades their picture without silently adding badges where
there were none. The two call sites that relied on the implicit default
(`SidebarRail`, `UserMenuPopover`) now say so explicitly.

Settings → Members gains the same primitive: its rows previously showed a name
and an email with no picture at all.

## Tasks

- [x] `api/src/services/uoa-avatar.ts` — subject lookup + domain-hash transport.
- [x] `GET /api/users/:userId/avatar` relay in `api/src/routes/users.ts`.
- [x] `useResolvedAvatarUrl` precedence + `userId` as an avatar source.
- [x] Thread `userId` through every `UserAvatar` call site.
- [x] Avatars on Settings → Members.
- [x] `api/test/uoa-avatar.test.ts` — linked user, unlinked user, upstream
      failure, cross-org isolation, content-type allowlist.
- [x] `docs/functionality.md` — user profile photo row.

## Verification

`pnpm lint`, `pnpm typecheck` and `pnpm test` all green from the repo root
(41/41 Turbo tasks; 482 API tests pass, 17 pre-existing DB-dependent skips).

Playwright headless against `http://localhost:5455`, both ways round:

- **Without UOA** (the local default — no `UOA_*` set): `/settings/members`,
  `/settings/profile` and `/channels/…` render the initials fallback with no
  layout change. The relay answers `404` + `cache-control: private, max-age=300`
  and the client falls through exactly as before. The clipped role `<select>`
  label on Settings → Members is pre-existing — the same screenshot on `main`
  shows it, and the member card's geometry is byte-identical with and without
  the avatar (card 163→279, select 234→266).
- **With UOA**, driven by a local stand-in for
  `GET /domain/users/:sub/avatar` plus a `linked` `ProductAccountLink` for the
  dev owner: the relay returned `200 image/svg+xml` with `x-uoa-avatar-source:
  generated`, `nosniff`, `content-security-policy: default-src 'none'` and
  `cache-control: private, max-age=300`, and the picture rendered on every
  surface at once — message rows, the sidebar DM entry, the channel-header
  member stack, the rail avatar (presence dot intact) and Settings → Members.
  One network request served roughly ten avatar instances on the channels page,
  confirming the single-URL-per-user caching choice. The stand-in and the
  fixture link were removed afterwards.

