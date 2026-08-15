# Deployment Modes and Authentication

> Status: target-state design.

## 1) Objective

Nessie must support both:

- hosted SaaS deployment,
- self-hosted deployment on local or organization-owned infrastructure.

That includes very small installs such as:

- a Mac mini,
- a single Linux server,
- a local Docker environment on a developer machine.

The product architecture must therefore stay provider-agnostic at the core, even when GCP is the reference hosted deployment.

## 2) Deployment modes

### 2.1 Hosted SaaS mode

Reference target:

- Google Cloud deployment,
- managed multi-tenant service,
- default external auth endpoint at `authentication.unlikeotherai.com`,
- cloud-managed data stores and background execution.

### 2.2 Self-hosted organization mode

Target:

- deploy on customer infrastructure,
- still support multi-user org/team/channel/agent model,
- use customer-selected auth provider(s),
- use local or customer-managed infrastructure adapters for storage, queue, and secrets.

### 2.3 Single-machine local mode

Target:

- run the whole system locally on one machine,
- support both Docker-first and non-Docker startup,
- suitable for Mac mini, workstation, or small lab server,
- minimal dependency installation outside Docker.

The local mode should still use the same core control plane and data model, just with simpler infrastructure adapters.

## 3) Architecture rule

The core app must not hard-code GCP or a single auth provider into domain logic.

Keep abstracted:

- auth provider,
- object storage provider,
- queue/event bus,
- secret encryption backend,
- deployment-specific observability plumbing.

Do not abstract prematurely:

- Postgres-centric data model,
- control-plane schema,
- task/session/run lifecycle,
- policy model.

## 4) Authentication modes

### 4.1 Hosted default

Hosted Nessie should default to:

- `authentication.unlikeotherai.com` as the primary auth entrypoint,
- SSO-based login,
- optional step-up verification for privileged actions.

If the deployment is configured for a single upstream identity path, login may auto-redirect to the SSO provider instead of showing a chooser page.

### 4.2 Self-hosted auth model

Self-hosted Nessie must support a configurable provider system for authentication.

That means:

- one or more SSO providers may be configured,
- local deployments can choose their own identity provider,
- the login experience may either:
  - show a provider chooser,
  - or auto-redirect directly when exactly one provider is configured and `autoRedirectToSso=true`.

Supported auth-provider concept shape:

- `providerId`
- `type`
- `label`
- `enabled`
- `autoRedirect`
- `issuerUrl`
- `clientId`
- `scopes`
- `mappingRules`

The public `GET /api/auth/providers` descriptor returns `providerId`, `type`,
`label`, `enabled`, `autoRedirect`, and a derived `url` — the authenticator's
public address (`issuerUrl` for OIDC/custom; the UOA base URL, `UOA_BASE_URL`,
for `uoa`). The admin Profile page renders this as the provider's friendly name
plus the URL as a subtitle.

Target provider types:

- OIDC
- SAML via gateway/adapter
- custom UOA adapter for `authentication.unlikeotherai.com`

### 4.3 Local login-page behavior

Local deployments must be able to disable forced auto-redirect.

Reason:

- when running locally, operators may want a visible login page with multiple configured SSO choices,
- they may not want browser flow to jump away immediately,
- local installs may also need a simpler bootstrap/admin onboarding flow.

Required config behavior:

- `auth.mode = hosted | selfHosted | local`
- `auth.autoRedirectToSso = true | false`
- `auth.providers = [...]`

### 4.3a Local bootstrap path

Fresh local installs need a concrete first-user bootstrap path even when no external SSO is configured yet.

This bootstrap path is mandatory for `nessie local up` to be usable on a fresh machine.

#### Bootstrap detection

The system is in bootstrap mode when the `users` table is empty. No config flag is needed — the condition is "zero users exist in the database."

#### Bootstrap flow

1. `nessie local up` starts the API.
2. The API detects zero users and generates a one-time bootstrap token (a cryptographically random UUID v4).
3. The launcher prints the token and the bootstrap URL to the console:
   ```
   First-time setup. Open this URL to create your owner account:
   http://localhost:4317/admin/bootstrap?token=<uuid>
   ```
4. The user opens the URL. `/admin` detects `bootstrapMode: true` from `GET /api/auth/me` (which returns a limited unauthenticated response during bootstrap — see below) and shows the bootstrap form.
5. The user enters: display name, email, password.
6. The frontend calls `POST /api/auth/bootstrap` with:
   ```ts
   {
     bootstrapToken: string;   // the UUID from the console
     email: string;
     displayName: string;
     password: string;
   }
   ```
7. The API validates:
   - the token matches the generated token,
   - no users or organization exist yet (prevents race conditions),
   - the token has not expired (15 minute TTL from generation).
8. On success, the API:
   - creates the owner user,
   - creates the default organization (deterministic ID),
   - creates the default project (deterministic ID),
   - creates the default team (deterministic ID),
   - binds the owner into all of them,
   - issues a JWT session token,
   - clears the bootstrap token from memory.
9. Returns `ApiResponse<{ token: string; me: MeResponse }>`.
10. `/admin` stores the JWT, seeds `AuthSessionProvider`, and redirects to the main UI.

Bootstrap initialization is serialized across API replicas with one
transaction-scoped PostgreSQL advisory lock. After acquiring the lock, the API
re-reads both the user and organization state and creates the initial user,
workspace hierarchy, memberships, board columns, and default policies in the
same transaction. A simultaneous local bootstrap loses that race with a `409
BOOTSTRAP_DISABLED`; simultaneous first UOA callbacks reuse the committed
organization and continue through the normal per-workspace and per-principal
locks. No caller may observe a partially seeded workspace.

#### Bootstrap mode detection from `/admin`

`GET /api/auth/me` during bootstrap (no `Authorization` header, no users exist) returns:

```ts
{
  data: {
    bootstrapMode: true,
    bootstrapUrl: '/admin/bootstrap'
  }
}
```

This is the only case where `GET /api/auth/me` returns a non-error response without authentication. Once any user exists, unauthenticated calls to `/api/auth/me` return `401`.

#### Bootstrap token rules

- generated once at API startup when zero users exist
- stored in memory only, never persisted to database
- UUID v4 format
- 15-minute TTL
- consumed on first successful use — cannot be reused
- if the API restarts before bootstrap completes, a new token is generated and printed

#### Post-bootstrap

After bootstrap, the install can:
- keep using local auth (email + password login via `POST /api/auth/session`)
  — **`local` mode only**, see below,
- switch to configured SSO providers,
- or expose both according to policy.

#### The local-password stack is gated to `local` mode

Local passwords exist for one reason: a fresh machine with no identity
provider has to be able to create its first human. Anywhere else the
authenticator owns identity, so the whole password stack is refused by the
**server**, not merely hidden from the login screen (which it already was —
the admin only offers the password form when the `local-bootstrap` provider is
advertised, and it is advertised in `local` mode only). When
`config.mode !== 'local'`:

| Route | Response |
|---|---|
| `POST /api/auth/session` (password branch) | `403 PASSWORD_AUTH_DISABLED` |
| `POST /api/users` (creates an account **with** a password) | `403 LOCAL_USER_CREATION_DISABLED` |
| `POST /api/auth/password` (password change) | `403 PASSWORD_AUTH_DISABLED` |

Notes on the shape of each refusal:

- The login gate is scoped to the **password branch** — a request carrying a
  `providerId` still runs the SSO code exchange unchanged. It refuses before
  the account is looked up, so it is not an account-existence oracle, and it
  refuses a request with no credentials at all rather than answering
  `400 PASSWORD_REQUIRED`, which would advertise a prompt the deployment will
  never honour.
- `POST /api/users` is refused after the owner check and before the body is
  parsed: members join a non-local install through SSO or an invitation, never
  by an owner typing somebody a password. (Replacing this route with the UOA
  invitation API is phase 5 of the gap analysis; the gate is what stops the
  bleeding meanwhile.)
- `POST /api/auth/password` is refused before the body is read and before an
  attempt is metered — there is no local password to change.

Bootstrap itself needs no mode gate and does not have one: `resolveBootstrapState`
already returns `null` (disarming bootstrap mode entirely) whenever any
non-`local-bootstrap` auth provider is enabled, and first SSO login provisions
the owner instead (`initializeSharedOrganization`). Every SSO-configured
deployment — including production, which is `selfHosted` with UOA — therefore
never reaches the bootstrap password at all.

The one combination the gate changes in practice is a `selfHosted`/`hosted`
install with **no** SSO provider configured: it still bootstraps an owner with
a password (bootstrap is armed, because no external provider is enabled), but
that password can never be used to sign in again — the owner rides the session
and refresh cookie the bootstrap exchange issued, and must configure an SSO
provider before it lapses. That is the deliberate consequence of scoping local
passwords to `local` mode; an install that wants a durable password login is a
`local` install. Resolved as ambiguity 1 of
[the UOA SSO gap analysis](plans/2026-08-14-uoa-sso-gap-analysis.md).

### 4.3b Session token contract (JWT)

All deployment modes use JWT for session tokens.

#### Token format

JWT signed with HS256 using a server-side secret.

Claims:

```ts
{
  sub: string;           // userId
  org: string;           // organizationId
  proj: string;          // projectId
  team: string;          // teamId
  roles: string[];       // role IDs
  iat: number;           // issued at
  exp: number;           // expiry
}
```

#### Token lifecycle

- the access JWT is **short-lived**: default 30 minutes, configurable via `NESSIE_AUTH_TOKEN_TTL`
- issued by `POST /api/auth/session` (login), `POST /api/auth/bootstrap` (first user), `GET /api/auth/dev-login`, `POST /api/auth/switch-context`, `POST /api/auth/uoa/workspace`, and `POST /api/auth/refresh`
- sent by the client as `Authorization: Bearer <token>` header on every request
- alongside the access token, every minting route sets a **rotating refresh token** in an httpOnly cookie (`nessie_refresh`, scoped to `/api/auth`); the client silently renews via `POST /api/auth/refresh` on app start, before the access JWT expires, when a request receives a 401, and when a resumed app is already within its renewal window
- app startup and API 401 recovery use one in-process single-flight coordinator,
  because a rotating refresh cookie may be consumed only once. Authenticated
  data queries mount only after session restoration completes
- a production Tauri window is pinned to the top-level hosted admin origin
  `https://app.nessie.works`, rather than an embedded `tauri://localhost`
  bundle. The latter makes the API refresh cookie third-party in macOS WebKit,
  where tracking prevention blocks it; development continues to use the local
  Vite origin and its same-origin API proxy
- only an explicit `401` from `POST /api/auth/refresh` proves that the saved
  session is no longer renewable and clears client credentials. Network errors,
  rate limits, and server failures preserve the stored access token and retry
  restoration with bounded backoff. Provider discovery belongs to the login
  query, retries independently, and never participates in session state
- the installed mobile shell exposes an explicit **session debug import** on
  the unauthenticated login surface. It accepts the JSON produced by the
  authenticated Session debug panel, compares its `apiBaseUrl` with the
  configured API, extracts only `tokens.accessToken`, and validates that bearer
  through the configured API's `GET /api/auth/me`. Dumped claims, identity,
  context, cookies, and storage are never applied or sent. The validated token
  is marked imported/nonrenewable, so 401 recovery never tries an unrelated
  WebView refresh cookie; it is cleared at its JWT expiry. Imported debug
  sessions also do not create a durable native push-device registration,
  cannot switch workspace scope, and sign out locally without revoking any
  ambient refresh family. To inspect another workspace, copy a dump while that
  workspace is active on the source device

#### Refresh tokens (rotating, server-tracked)

- the refresh token is an opaque 256-bit value; only its SHA-256 hash is stored (table `refresh_tokens`), never the raw value
- TTL default 30 days, configurable via `NESSIE_AUTH_REFRESH_TOKEN_TTL`; every
  successful rotation renews that window, so an active session can continue
  without a fixed absolute expiry
- **rotation:** each `POST /api/auth/refresh` atomically consumes the presented token and issues a deterministic HMAC-derived successor in the same `family_id`, returning a fresh access token + a new refresh cookie. Only hashes are stored; the server can reconstruct a successor only from the predecessor cookie and its auth secret. The original login provider is preserved across refresh; org/role membership is re-resolved each time
- **lost-response/concurrency grace:** for 60 seconds after rotation, replaying a just-consumed predecessor reissues the current verified live descendant. The replay also places a 60-second rotation barrier on that descendant, so a concurrently held current cookie returns the same value even when its HTTP response is delivered after the predecessor response. This makes overlapping WebView lifecycles and lost HTTP responses idempotent without creating multiple live successors
- **cross-replica serialization:** every family decision takes a PostgreSQL
  transaction-scoped advisory lock. Security-sensitive issuance, password
  change, deactivation, and user-wide revocation take a separate per-user lock
  before sorted family locks. This fixed order prevents a second API replica
  from issuing a session after revocation or racing logout past a rotation
- **reuse detection:** presenting an already-revoked token after that 60-second grace, or presenting a token whose replacement chain is missing, cyclic, cross-family, or does not match the derived token hash, revokes the entire family and forces re-login
- **UOA renewal:** a new UOA login must return an opaque refresh credential and
  nonnegative `tv`. Nessie encrypts the upstream credential with AES-256-GCM in
  `uoa_session_credentials`, coupled to one local family and its current local
  token; it never enters the browser. Each active local rotation uses one short
  family-locked preflight, obtains UOA's exact-context replay-safe successor
  **outside every database transaction**, validates the immutable
  `{sub, org, team}` tuple and monotonic epoch, then uses a second short locked
  compare-and-swap to atomically advance the stable product-link epoch,
  encrypted credential, and deterministic Nessie successor. If an ancestor
  replay installs the local cookie barrier while renewal is in flight, finalize
  keeps that cookie and adopts the exact UOA successor in place; it never drops
  an accepted upstream rotation. Concurrent calls may reach UOA with the same
  credential, but identical finalizers converge, so SSO latency cannot pin the
  database pool. A replay of the
  local predecessor returns the already-committed local successor without a
  second UOA call. Transient UOA/network failures preserve the family and return
  `503`; definitive revocation, tuple drift, or malformed family proof returns
  `401` and erases it. Legacy UOA families without encrypted proof reauthenticate.
- **UOA workspace rescoping:** authenticated UOA sessions switch without a
  browser login through `POST /api/auth/uoa/workspace` with external
  `{ organizationId, teamId }`. The access bearer and httpOnly cookie must bind
  to the same user, provider, session id, and exact encrypted source
  `{sub, org, team, tv}`. Under the family lock, Nessie creates one
  `uoa_workspace_switch_intents` row bound to the source credential generation,
  current local-token id, and upstream-token hash before any external call.
  After direct Nessie access is confirmed, Nessie calls UOA's existing token
  endpoint with
  `grant_type=urn:unlikeotherai:params:oauth:grant-type:workspace-switch`, the
  opaque refresh token, and the exact target. The authoritative switched
  identity then idempotently materializes the target local workspace, including
  its claimed team role. The intent/source is rechecked immediately before
  every credential-bearing call. Finalization uses the same
  deterministic local rotation funnel as ordinary refresh and atomically
  rescope-updates the family proof, first-party link epoch/last-seen workspace,
  local cookie successor, and intent deletion. An ordinary refresh that finds a
  live intent resumes that exact switch; without one it accepts only UOA's
  same-scope immediate child. If an ordinary same-scope rotation already won,
  its adoption and exact-intent cancellation are one transaction. Safe target
  refusals (`WORKSPACE_NOT_AVAILABLE`, `INTERACTION_REQUIRED`, or
  `WORKSPACE_SWITCH_CONFLICT`) never revoke the source family; only
  `INVALID_REFRESH_TOKEN` and invalid/tampered source proof force re-login,
  surfaced to the browser as `WORKSPACE_SWITCH_REAUTH_REQUIRED` so it clears
  stale local session state instead of treating the result as a safe 2FA step-up.
  After UOA accepts a switch, transient local materialization failures retain
  the intent for exact replay, while a permanent local binding collision
  revokes the now-unrecoverable source family rather than retaining a consumed
  upstream credential.
  Every successful UOA renewal also reads `/org/me` with the fresh access token
  and transactionally replaces the cached workspace directory used by the
  switcher, so membership removals and avatar/name changes appear without a new
  login. That directory is display-only and never authorizes a switch. If the
  optional directory read is unavailable, Nessie retains the last verified
  copy while continuing the independently authorized token rotation.
  UOA session and billing requests use IP-pinned `safeFetch` and allow zero
  redirects, so refresh credentials, domain hashes, app keys, and signed actor
  assertions are never forwarded to a redirect target.
- **workspace binding:** refreshed UOA access sessions resolve the exact local
  team mapped to the signed external org/team and require live user, project,
  team, organization, and Nessie product-link membership. They never fall back
  to the user's first membership. The one account link per user/product proves
  stable subject/status/credential epoch only; its active org/team columns are
  last-seen metadata and cannot invalidate a simultaneous family in another
  team. The product link may mirror a newer epoch after a valid refresh, but it
  never supplies session identity. Billing, delegated calls, activation, team
  enablement, and webhook routing all derive workspace authority from the signed
  family plus the exact Team mapping.
- **revocation:** `DELETE /api/auth/session` (logout) is now **public** and cookie-driven — it revokes the token family server-side and clears the cookie, so a session can be killed even after the access token has expired. Password change, user deactivation, explicit session revocation, expiry, and reuse detection erase both matching local families and encrypted UOA credentials atomically. The access JWT itself remains stateless (verified by signature + `exp`); UOA sessions additionally carry immutable `uoaIdentity { subject, organizationId, teamId, tokenVersion }` proof
- **credential retention:** startup and five-minute bounded sweeps take each
  candidate's family lock, retain hash-only local token history, revoke any
  remaining live row, and erase encrypted UOA state once either the upstream
  credential or current local token has expired
- cookie attributes: `HttpOnly`, `SameSite=None; Secure` in hosted/self-hosted (admin and API are different subdomains), `SameSite=Lax` over http in local (same origin via the Vite proxy)

#### Active project/team

- `proj` and `team` claims are the user's **active** project and team, not their only one
- local/non-UOA project/team switching: `POST /api/auth/switch-context` with `{ organizationId, projectId, teamId }` → issues a new JWT with updated claims (and rotates the refresh cookie)
- UOA workspace switching: `POST /api/auth/uoa/workspace` with external `{ organizationId, teamId }` → rescope-rotates the bound UOA/local refresh family and issues the corresponding JWT without leaving the app
- the active project/team determines the default scope for channel listing, agent discovery, and policy evaluation

#### Server-side signing secret

- generated automatically on first launch if not set
- stored as `NESSIE_AUTH_SECRET` env var or in the config file
- if the secret changes, all existing tokens become invalid (users must re-login)

#### Login flow (post-bootstrap)

`POST /api/auth/session`:

```ts
// Request
{ email: string; password: string; providerId?: string }

// Response — ApiResponse<{ token: string; me: MeResponse }>
```

The email + password shape above is **`local`-mode only**. On any other mode
the route answers `403 PASSWORD_AUTH_DISABLED` before looking the account up
(§4.3a, "The local-password stack is gated to `local` mode"); the SSO branch
below is unaffected and is the only way into a hosted or self-hosted install.

For SSO providers, the flow is:
1. frontend requests an authorize URL with PKCE and an explicit redirect URI
2. web frontend navigates to the SSO provider and returns to `/login?code=...`
3. Tauri desktop opens the authorize URL in the system browser and returns via
   `nessie://auth/callback?code=...`
4. frontend calls `POST /api/auth/session` with `{ providerId, code, codeVerifier, redirectUri }`
5. API exchanges code for user info, creates or matches the user, issues JWT

#### UOA workspaces → Nessie environments (Slack-style login)

For the `uoa` provider, Nessie's config JWT enables UOA's workspace chooser
(`login_flow.workspace_selection: "auto"`), so the user picks a **workspace**
before returning; UOA then carries the selection in the access-token
`active { orgId, teamId }` claim plus the authentication epoch in `tv`. The same
config JWT sets `org_features.allow_user_create_org` **and**
`allow_user_create_team`, so the chooser offers self-service workspace creation
both to a user with no organisation yet (`_org`, their first one) and to an
ACTIVE owner/admin of an organisation they already run (`_team`, a further
workspace via UOA's `POST /auth/create-team`). Without the `_team` flag the
chooser shows no create option to anyone who already belongs to a workspace. On
exchange, `POST /api/auth/session` routes
the session to that workspace instead of the first org's default team: the
selected UOA workspace maps to a Nessie **Team** inside the one shared
Organization (auto-provisioned — project + team + `#general` — on first entry;
the first person owns it). Users switch between workspaces they belong to via
the authenticated `POST /api/auth/uoa/workspace` rescope route; the browser does
not leave Nessie or repeat hosted login. `POST /api/auth/switch-context` remains
the local/non-UOA context route and still refuses to mint a UOA token for a
different external tuple. The signed session/family proof, rather than
`ProductAccountLink`, is authoritative for billing actors and delegated calls.
Before provisioning a local workspace, mutating product links, or issuing a
Nessie session, login confirms exact direct `nessie` access through UOA using
the signed `{sub, org, team, tv}` subject. Product-link upserts are one atomic,
slug-ordered transaction: an existing subject cannot be replaced and an older
epoch cannot overwrite a newer one. First-time workspace creation is likewise
serialized by an advisory lock over the exact external organization/team, so
simultaneous first logins converge on one project and team.

**UOA principals are matched by the stable UOA subject, never by email.**
`User.uoaSub` (unique, nullable) is the principal key: login and workspace
materialization resolve `where: { uoaSub }` first
(`api/src/services/workspace-principal.ts`). On a subject miss, a **one-time
adoption** claims an email-matching row only while that row is unbound
(`uoaSub IS NULL` — a pre-subject account, a bootstrap-seeded owner, or a row
the backfill migration deliberately left NULL as ambiguous), setting the
subject inside the same transaction. An email row already bound to a
*different* subject fails the login closed with `409 UOA_IDENTITY_CONFLICT`
(`UoaSubjectConflictError`) — the account is never taken over and no duplicate
is created (email stays unique; a later phase de-duplicates profile data).
Principal resolution and every membership write are serialized by advisory
locks keyed on the subject and — second, always in that order — the normalized
email; the email lock remains because the adoption path and non-UOA logins
resolve rows through the unique email column, so concurrent device callbacks
for one principal, or two subjects racing one address, meet on a common lock
instead of the read-then-create window. The workspace-switch materialization
guard compares the session's verified subject against `User.uoaSub` (a NULL
subject fails closed to reauthentication). Existing rows were backfilled from
`linked` `nessie` product-account links
(`20260815090000_user_uoa_subject_keying`); a subject mapping to two users was
left NULL on both rather than guessed.
Non-UOA OIDC providers keep email keying unchanged, and they plus
single-workspace users carry no `active` claim and
land in their existing/default team, unchanged. See
[docs/plans/2026-07-10-slack-workspace-login-nessie.md](plans/2026-07-10-slack-workspace-login-nessie.md).

**The profile columns are a non-authoritative mirror, re-synced from verified
claims.** UOA owns the profile of every principal that signs in through it;
`User.displayName` and `User.avatarUrl` exist only so a name and a picture can
be rendered without a round trip per row. Three consequences:

- **Nothing manufactures a profile.** `resolveIdentityDisplayName` returns the
  name the provider actually asserted or nothing at all — a candidate that
  merely echoes the email address is not an assertion — and a brand-new row is
  named by its email address until the provider supplies a name. The old
  `/api/auth/me` synthesizer, which derived "Ada Lovelace" from
  `ada.lovelace@example.com` and persisted it on **every** call, is deleted;
  `buildMeResponse` now writes nothing at all.
- **Every exchange that carries verified claims re-syncs the mirror**
  (`api/src/services/uoa-profile-mirror.ts` `syncProfileMirrorFromClaims`):
  SSO login and workspace-switch materialization through
  `ensureWorkspacePrincipal`, and ordinary session refresh through the UOA
  refresh coordinator (best-effort there — a display-data write must never
  break session renewal). Only fields the provider asserted are written, and
  only when they differ, so a provider that sends no picture claim leaves the
  mirror alone rather than blanking it. The narrow "stored name equals the
  email" repair in `auth-login.ts` is replaced by this general sync.
- **The picture follows the same authority.** Client precedence is UOA relay →
  local upload → provider `picture` → initials, and Gravatar is gone from the
  chain and from the API contract entirely (it was derived from the email —
  UOA's data — and leaked a hash of every member's address to a third party for
  a fallback initials already cover). A UOA session's
  `PATCH /api/auth/me/avatar` is refused with `403 PROFILE_MANAGED_BY_SSO`; it
  changes the photo at the source through
  `PUT`/`DELETE /api/auth/me/avatar/uoa`, which relays multipart bytes to UOA
  `/domain/users/:uoaSub/avatar` using the acting user's own `User.uoaSub` —
  never a subject from the request, because the domain-hash bearer is full
  system trust and applies no per-person check upstream. The local-attachment
  path is unchanged for deployments with no UOA.

Dropping the columns outright (and serving the profile from a bounded in-memory
UOA-backed read) is the remaining step of Phase 3 in
[docs/plans/2026-08-14-uoa-sso-gap-analysis.md](plans/2026-08-14-uoa-sso-gap-analysis.md).

UOA billing may return `401` when the actor epoch has advanced. The API
preserves that status, and the shared browser client performs exactly one
single-flight cookie renewal and one request retry. A second `401` or a rejected
refresh is terminal; transient refresh failures do not clear the local session.

### 4.3c Fastify auth middleware

The API uses a Fastify `preHandler` hook for authentication.

#### Request decoration

```ts
// Fastify decorator
fastify.decorateRequest('actorContext', null);

// Type
declare module 'fastify' {
  interface FastifyRequest {
    actorContext: AuthorizedActionContext | null;
  }
}
```

#### Auth hook behavior

On every request:

1. Check if the route is marked public (see below). If public, skip auth.
2. Extract `Authorization: Bearer <token>` from headers.
3. If missing or malformed: return `401 { error: { code: 'AUTH_REQUIRED', message: 'Missing or invalid authorization header' } }`.
4. Verify and decode the JWT using the signing secret.
5. If expired: return `401 { error: { code: 'TOKEN_EXPIRED', message: 'Session expired' } }`.
6. If signature invalid: return `401 { error: { code: 'TOKEN_INVALID', message: 'Invalid session token' } }`.
7. Look up the user by `sub` claim in Postgres (to ensure they still exist and are not disabled).
8. If user not found: return `401 { error: { code: 'USER_NOT_FOUND', message: 'User no longer exists' } }`.
9. Construct `AuthorizedActionContext` from JWT claims + generate `requestId` (UUID v4).
10. Attach to `request.actorContext`.

#### Public routes (no auth required)

- `GET /api/health`
- `GET /api/auth/providers`
- `GET /api/auth/me` (during bootstrap mode only — returns bootstrap detection response)
- `POST /api/auth/bootstrap`
- `POST /api/auth/session`
- `POST /api/auth/refresh` (identity comes from the httpOnly refresh cookie, not a Bearer token)
- `DELETE /api/auth/session` (logout; revokes the refresh-token family via the cookie)

Mark public routes with a Fastify route option:

```ts
fastify.get('/api/health', { config: { public: true } }, handler);
```

The auth hook checks `request.routeOptions.config.public` and skips validation if true.

#### Actor context construction

From a decoded JWT with claims `{ sub, org, proj, team, roles }`:

```ts
const actorContext: AuthorizedActionContext = {
  actor: {
    actorType: 'user',
    actorId: sub,
    roles: roles,
  },
  tenant: {
    organizationId: org,
    projectId: proj,
    teamId: team,
  },
  actionContext: {
    requestId: generateUuid(),
  },
};
```

Route handlers enrich `actionContext` with request-specific fields (`channelId`, `agentId`, `threadId`, etc.) from path params or body before passing to service layer.

### 4.3d Phase 1 single-user simulation mode

Phase 1 may run in a single-user simulation mode after bootstrap.

Meaning:

- one real authenticated owner account exists,
- the broader org/project/team structure exists in the data model,
- but the install may operate with deterministic default container records instead of full multi-user setup.

Allowed Phase 1 approach:

- create one default organization,
- create one default project,
- create one default team,
- bind the owner user into them automatically,
- let channels and agents live inside that default containment model.

These IDs may be deterministic reserved IDs for local/bootstrap installs.

Guidance:

- deterministic seeded IDs are acceptable,
- avoid ad hoc per-page or per-feature fake identity generation,
- all actor context should resolve from the same auth/session source.

### 4.4 Model/provider auth separation

User authentication and model-provider authentication are separate concerns.

- user auth = who may enter and use Nessie,
- model auth = which API keys or provider accounts Nessie may use at runtime.

Model-provider auth should stay in the secret system, not in end-user SSO config.

### 4.5 Single source of truth for identity

There must be one canonical auth/session source for the product.

Rules:

- login state comes from one backend auth/session contract,
- current user identity comes from one canonical `me` endpoint,
- current org/project/team context comes from the same canonical session payload or follow-up bootstrap payload,
- frontend apps must consume this through one shared auth/session module.

Do not do this:

- every page calling its own auth helper,
- multiple frontend-only sources of truth for current user,
- ad hoc classes that separately reconstruct reusable auth/user objects.

Required Phase 1 contract shape:

- session token or equivalent credential
- `GET /api/auth/me`
- one shared frontend auth/session provider in `/admin`
- one canonical actor context passed to agent/runtime calls
- `GET /api/auth/me` returns `ApiResponse<MeResponse>` from [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)

## 5) Local deployment and startup

### 5.1 Docker-first local install

Local Nessie must be runnable entirely through Docker without requiring complex host-level installs.

Target local experience:

- install one lightweight launcher globally,
- run one command,
- all required local services start in Docker,
- all persisted state lands locally on the machine.

### 5.1a Non-Docker local install

Nessie must also support a first-class non-Docker local install path.

Reason:

- some operators do not want Docker at all,
- some local hosts already run system services directly,
- some users want lower overhead on Mac mini or workstation setups.

The non-Docker path should still be easy, but it must be honest about required dependencies.

### 5.1b Local dependency model

Required local dependency for non-Docker mode:

- PostgreSQL

Optional local dependencies:

- Redis
- MinIO or another S3-compatible local object store

Default local storage guidance:

- Postgres is required as the durable system of record,
- Redis is optional in early local mode and should only be required for features that truly depend on ephemeral coordination,
- MinIO should be optional because a local filesystem object-store adapter can serve as the simplest default for local installs.

Local object storage modes:

- `filesystem` adapter for simplest local installs,
- `minio` or `s3-compatible` adapter for users who want object-storage parity.

### 5.1c Degraded local mode

If optional dependencies are missing, Nessie should still start where possible and clearly describe degraded functionality.

Examples:

- without Redis:
  - reduced rate-limiting sophistication,
  - reduced ephemeral session/state performance,
  - some interactive/session-heavy features may be disabled or downgraded.
- without MinIO:
  - use local filesystem object storage,
  - signed URL parity may be reduced or implemented locally.

The launcher must report these degradations explicitly instead of failing silently.

### 5.2 Global launcher requirement

There should be a simple global command path for local installs.

Example target experience:

```bash
npm install -g nessie
nessie local up
```

Equivalent launcher forms may also exist:

- `pnpm dlx nessie local up`
- `npx nessie local up`

But the product should explicitly support the "simple global install and launch" path.

### 5.3 Local launcher responsibilities

The local launcher should:

- generate local config,
- start Docker Compose or equivalent local stack when Docker mode is selected,
- start app processes directly when non-Docker mode is selected,
- create local storage directories,
- open the local app URL,
- print bootstrap/admin login information,
- manage stop/restart/update commands,
- detect missing dependencies and recommend install steps per OS.

Suggested commands:

- `nessie local up`
- `nessie local down`
- `nessie local status`
- `nessie local logs`
- `nessie local reset`
- `nessie local doctor`

Suggested launcher behavior:

- `nessie local up --docker`
- `nessie local up --no-docker`
- `nessie local doctor`
  - checks `postgres`
  - checks optional `redis`
  - checks optional `minio`
  - reports current object-storage mode
  - prints install guidance for macOS, Linux, or Windows

### 5.4 Local persistence requirement

For local mode, all persistent data should land locally by default:

- Postgres data volume,
- object storage volume or local object-store adapter,
- local secrets backend data,
- uploaded files and artifacts.

The launcher should make local data locations explicit and controllable.

## 6) Recommended self-hosted baseline

First-class self-hosted baseline:

- Docker Compose
- Postgres
- optional Redis
- local disk or S3-compatible object storage
- pluggable auth provider

This is the OSS-friendly path and should be documented as the main self-hosting story before more advanced Kubernetes guidance.

### 6.1 Recommended non-Docker baseline

First-class non-Docker local baseline:

- Postgres required
- optional Redis
- local filesystem object storage by default
- optional MinIO for S3-compatible local parity
- pluggable auth provider
- one global launcher command path that can guide dependency setup

This keeps non-Docker installs realistic without pretending the system has zero dependencies.

## 7) Cross-links

- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [secret-management-spec.md](./secret-management-spec.md)
- [phase2-gcp-deployment-spec.md](./phase2-gcp-deployment-spec.md)
- [policy-enforcement-spec.md](./policy-enforcement-spec.md)
- [functionality.md](./functionality.md)
