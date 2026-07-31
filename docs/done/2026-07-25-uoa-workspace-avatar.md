# UOA workspace (company) avatars in Nessie (2026-07-25)

## Goal

Give a workspace the same treatment
[the user avatars](2026-07-25-uoa-user-avatars.md) just got: show the company
picture the team actually manages in UnlikeOtherAuthenticator (UOA), and let an
owner/admin change it from Nessie without leaving for the UOA console.

## Contract (verified live on 2026-07-25)

The team ("company") avatar endpoints did not exist when the user-avatar work
shipped earlier today — `GET /api` listed 243 endpoints with no `*/teams/*/avatar`
path. They are live now (252 endpoints), in two flavours:

| Route | Auth |
| --- | --- |
| `GET/PUT/DELETE /domain/teams/:teamId/avatar?domain=…` | domain hash bearer **only** |
| `GET/PUT/DELETE /org/organisations/:orgId/teams/:teamId/avatar` | domain hash + `X-UOA-Access-Token` + signed config |

UOA's own guidance settles which to use, and it names our exact constraint:

> Products keep the bound refresh credential rather than a spendable access
> token, so the dual-auth `/org/*` mutations cannot be driven from a backend at
> all.

So Nessie uses the `/domain/*` flavour throughout — the same domain-hash bearer
(`SHA256(UOA_DOMAIN + UOA_CLIENT_SECRET)`) the user-avatar relay already mints.
This is what unblocks the half of the original request that was previously
unbuildable; nothing about Nessie's refresh-credential handling changes.

- `GET` always returns image bytes for a team the domain can see: uploaded image
  → server-side proxy of the team's `iconUrl` → deterministic generated SVG.
  `X-UOA-Avatar-Source` reports which. Cross-domain team → generic `404`.
- `PUT` takes `multipart/form-data` with one part named `file`: PNG/JPEG/WebP,
  max 1 MiB, type decided by **magic-byte sniffing** server-side (SVG rejected).
  Returns `{ ok, avatar: { source, content_type, size_bytes, updated_at } }`.
- `DELETE` is idempotent, returns `{ ok: true }`, and falls resolution back to
  `iconUrl` / generated. `iconUrl` itself is never touched by these routes.
- Mutations are rate-limited 30/hour per domain + team.

**The `/domain/*` mutations apply no role check of their own** — per UOA brief
§24.10 the domain hash is full system trust for the domain. UOA is explicit that
the calling product must gate first:

> enforce your own owner/admin gating before relaying the call.

That gate is therefore load-bearing, not decorative, and is the single most
important thing to get right here.

## Design

### Which team

The workspace is the team — the thing `WorkspaceSwitcher` switches between. The
UOA team id is `Team.externalWorkspaceId`, always resolved through the actor's
own organization for current-workspace operations. The current-workspace read
and both mutation routes resolve the actor's **session** team and never accept a
team id from the request. The switcher's read-only route accepts a local team id
but requires a `TeamMember` row for the signed-in user before the full-trust UOA
relay is called; this safely covers every organization in the user's workspace
list. A team with no `externalWorkspaceId` (a local, non-UOA team) is a `404`,
exactly like an unlinked user.

Unlike the billing calls, no UOA session identity is required. The team id comes
from Nessie's own row and the credential is Nessie's own; a member reading their
workspace's picture should not have to have signed in through SSO this session.

### API

| Route | Who |
| --- | --- |
| `GET /api/workspace/avatar` | any authenticated actor in the workspace |
| `GET /api/teams/:teamId/avatar` | a signed-in user who belongs to that team |
| `PUT /api/workspace/avatar` | organisation **owner or admin** |
| `DELETE /api/workspace/avatar` | organisation **owner or admin** |

The role is read from `actorContext.actor.roles`, which `server-context.ts`
re-resolves from the live `OrganizationMember` row on every request precisely so
guards cannot be fooled by a stale token claim.

`GET` mirrors the user relay exactly: content-type allowlist
(`png|jpeg|webp|svg+xml`), bounded read, `nosniff`,
`content-security-policy: default-src 'none'`, `cache-control: private,
max-age=300`, cacheable `404` when there is no UOA workspace, `502` when the
upstream is unreachable.

`PUT` relays the multipart part straight through. The 1 MiB ceiling is enforced
at Nessie's multipart layer *before* the bytes are buffered, and the declared
type is allowlisted so an obvious mistake fails fast with a clear message —
UOA's magic-byte sniff stays the real authority. Both mutations invalidate the
cached preview.

> **Not a `FileService` case.** The repo rule is that all blob file work goes
> through the one `FileService`. That governs bytes Nessie *stores* — attachments,
> quota accounting, `StorageUsageEvent`. Nothing here is stored: the bytes are
> relayed to UOA, which owns them, and Nessie keeps no row and consumes no quota.
> Routing this through `FileService` would create an attachment that nothing
> references and bill the org's storage budget for a file it does not hold.

### Admin

- `WorkspaceAvatar` primitive (`admin/src/components/primitives/`), sibling of
  `UserAvatar`: resolves either `/api/workspace/avatar` or the membership-scoped
  `/api/teams/:teamId/avatar` through the existing
  `useAuthedObjectUrlFromPath` bearer-fetch helper, and falls back to workspace
  initials. Square-ish (`rounded-xl`) to match how the workspace already
  renders, versus the round user avatar.
- The sidebar rail has one workspace identity control: the workspace-switcher
  button. The older organization-logo/smiley badge above it was removed. The
  active button and every menu row render the appropriate UOA team picture.
- The switcher menu is positioned from its top edge and receives a
  viewport-bounded maximum height, so opening it near the top of the window
  cannot grow the menu offscreen.
- `WorkspaceAvatarPanel` on Settings → Organization → General, directly beside
  the existing `LogoPanel`, whose shape it follows (preview, upload, remove,
  and the same "only owners and admins" message when `canEdit` is false).

The org logo and the workspace avatar are genuinely different things and the
panel says so: the logo is Nessie's own org-wide brand mark on the sign-in
screen, the workspace avatar is the company picture UOA holds for this team and
shows in every UOA surface.

## Tasks

- [x] Extend `api/src/services/uoa-avatar.ts` — team subject resolution +
      `GET`/`PUT`/`DELETE` transport, sharing the user relay's settings, timeout,
      bounded read and content-type allowlist.
- [x] `api/src/routes/workspace-avatar.ts` — three relay routes + the owner/admin
      gate, registered in `api/src/index.ts`.
- [x] `WorkspaceAvatar` primitive + sidebar workspace-switcher button.
- [x] Membership-scoped team-avatar reads for all workspace-switcher rows,
      duplicate rail branding removal, and viewport-safe menu placement.
- [x] `WorkspaceAvatarPanel` on Organization → General + facade hooks.
- [x] `api/test/uoa-workspace-avatar.test.ts` — read/upload/remove happy paths,
      member and viewer rejection, non-UOA team, oversize and wrong-type upload,
      upstream failure.
- [x] `docs/functionality.md` row.

## Verification

`pnpm lint`, `pnpm typecheck` and `pnpm test` green from the repo root (11 new
API tests). The role gate is asserted from the other side too: the `member` and
`viewer` cases fail the test outright if a request ever reaches the relay.

This machine holds no UOA domain credential, so the live service could not be
called — and writing a real company avatar into production UOA would not have
been an appropriate way to test. Instead the endpoints were driven against a
local stand-in implementing the published `/domain/teams/:teamId/avatar`
contract (domain-hash check, multipart part `file`, uploaded-over-generated
precedence, `X-UOA-Avatar-Source`), with `Team.externalWorkspaceId` bound on the
dev team. Everything below was then exercised through the running app and
removed afterwards.

- `GET` relayed to
  `…/domain/teams/<externalWorkspaceId>/avatar?domain=…` with a
  `Bearer <64-hex>` domain hash, returning `200 image/svg+xml` with
  `x-uoa-avatar-source: generated`, `nosniff`,
  `content-security-policy: default-src 'none'` and
  `cache-control: private, max-age=300`.
- `PUT` relayed a 207-byte PNG unchanged; the following `GET` returned those
  exact bytes as `image/png` with `x-uoa-avatar-source: uploaded`. An
  `image/svg+xml` upload was refused with `415 UNSUPPORTED_IMAGE_TYPE` before any
  call to UOA.
- Playwright headless at `/settings/organization`: the panel renders beside the
  logo panel — square against the logo's circle — with the upload and remove
  controls. Uploading through the real file input produced `PUT 200` followed by
  `GET …?v=1` in **both** the panel and the sidebar rail, so the shared revision
  counter defeats the five-minute cache in every component at once; the rail
  showed the new image immediately. The remove button produced `DELETE 200` and
  fell back to the generated image. No page errors throughout.
- With `UOA_*` unset (the local default) every relay answers a cacheable `404`
  and both surfaces show workspace initials with no layout change.

Not exercised end to end: the panel's non-admin branch. Settings → Organization
is owner-only at the page level (pre-existing, shared with the logo panel), so a
member never reaches the panel to see its "only owners and admins" message. The
gate that actually matters — the API refusing `PUT`/`DELETE` for a member or
viewer — is covered by tests.
