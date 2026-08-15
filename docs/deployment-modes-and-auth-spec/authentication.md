# Authentication

> Part of [Deployment Modes and Authentication](overview.md).

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

#### Membership and roles are gated to `local` mode

Same reasoning, one level up: outside `local` mode the identity provider owns
org/team membership and roles, and the local rows are a **projection** of the
verified session claims (next section). A local write would therefore be
reverted at the next login or token rotation, so the server refuses it rather
than pretending it took. When `config.mode !== 'local'`, each of these answers
`403 LOCAL_MEMBERSHIP_MANAGEMENT_DISABLED` ("Membership and roles are managed
in your identity provider."):

| Route | What it mutated locally |
|---|---|
| `PATCH /api/users/:userId` | organization role |
| `POST /api/users/:userId/deactivate` | membership kill-switch |
| `POST /api/users/:userId/reactivate` | membership kill-switch |
| `POST /api/teams/:teamId/members` | team roster + role |
| `POST /api/projects/:projectId/members` | project roster + role |
| `DELETE /api/projects/:projectId/members/:userId` | project roster |

The gate sits after the owner check and before any body parse or database read
(`api/src/routes/membership-mode-gate.ts`), matching the password gates above.
Consequences worth stating:

- The **last-active-owner invariant** (`LAST_OWNER`, enforced atomically under
  a `FOR UPDATE` lock on the org's owner rows) is now a `local`-mode rule for
  these routes. The service functions are untouched, and the same owner lock is
  reused as a floor by the UOA role projection (see below).
- **`ChannelMember` is deliberately not covered.** A channel is a Nessie
  product concept, not a UOA roster, and stays mutable in every mode. So do
  knowledge-space and dashboard grants.
- Reads are untouched: `GET /api/users` and the team/project listings still
  work, because a non-local deployment still has to *show* its roster (phase 5
  re-points that read at the UOA roster API).

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
  proof-gap answers (`INTERACTION_REQUIRED`, `NO_REFRESH_TOKEN`,
  `INVALID_REFRESH_TOKEN`, and `WORKSPACE_SWITCH_REAUTH_REQUIRED`) enter the
  same exact-target in-app reauthorization flow. The current Nessie session is
  retained: only the UOA proof step opens the system browser, and its callback
  returns to the route where switching began. Cancellation, provider failure,
  or a target mismatch never logs out or applies a different workspace.
  After UOA accepts a switch, transient local materialization failures retain
  the intent for exact replay, while a permanent local binding collision
  revokes the now-unrecoverable source family rather than retaining a consumed
  upstream credential.
  Every successful UOA renewal also reads `/org/me` with the fresh access token
  and replaces the cached workspace directory used by the switcher, so
  membership removals and avatar/name changes appear without a new login. That
  directory is display-only and never authorizes a switch. If the optional
  directory read is unavailable, Nessie retains the last verified copy while
  continuing the independently authorized token rotation.
  **The directory is UOA-owned data, so it lives only in a bounded in-memory
  cache** (`api/src/services/uoa-directory-cache.ts`: per user, 30-minute TTL,
  LRU-bounded at 10,000 users), written at login and at every rotation
  — including a workspace switch — and read by `GET /api/auth/me`. It is never
  persisted; migration
  `20260815120000_drop_uoa_workspace_directory_mirror` removed the former
  `ProductAccountLink.metadata.workspaceDirectory` mirror.
  The cache is per process: each API replica repopulates from its own logins and
  rotations, and a replica that has not yet served one for a user answers from a
  **degraded fallback** derived only from data Nessie owns — the user's own
  `TeamMember` rows joined to `Team.externalWorkspaceId` / `externalOrgId`, with
  the local team name as the label and UOA's deterministic per-team image URL as
  the avatar. A workspace the person is entitled to in UOA but has never opened
  in Nessie has no local Team row and therefore appears only once a rotation
  refreshes the real directory.
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
- **revocation:** `DELETE /api/auth/session` (logout) is public but requires a
  authentic signed Bearer session to revoke exactly that session's `{sub,
  sid}`; an expired access TTL does not prevent this exact revocation.
  It ignores the ambient refresh cookie and deliberately sends no generic
  cookie-clear header: a delayed logout response from an older app instance
  must never revoke or erase a newer login's same-name cookie. The frontend
  clears its local session immediately, while every authenticated request also
  requires a live, unrevoked, unexpired refresh row for the Bearer `sid`, so the
  logged-out access JWT stops working without changing another session's user
  generation. Password change, user deactivation, explicit session revocation,
  expiry, and reuse detection erase matching local families and encrypted UOA
  credentials atomically. UOA sessions additionally carry immutable
  `uoaIdentity { subject, organizationId, teamId, tokenVersion }` proof.
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

The always-mounted callback owner handles web `/login`, Tauri deep links, and
the iOS/Android WebView bridge through the same single-claim completion path.
External authorization is single-flight until callback completion conclusively
clears the pending intent. The intent survives an app or WebView reload, and a
native callback is retained and redelivered until the SPA acknowledges completed
handling. A bounded session-scoped cache of completed callback proofs suppresses
a redelivery after a lost native acknowledgement before it can claim a newer
intent; a second launch cannot replace the verifier for a state-less UOA callback.
Callbacks wait for startup session restoration when they carry an authenticated
workspace target; a target callback can only call the bearer-authenticated
recovery exchange and can never fall back to ordinary login.

#### Authenticated workspace-switch recovery (`expectedWorkspace`)

`POST /api/auth/session` also accepts an `expectedWorkspace { organizationId,
teamId }` discriminant for **workspace-switch reauthorization** — the browser
re-runs hosted UOA login for the target workspace while holding a current
Nessie session. It is valid ONLY as a complete `providerId: "uoa"` code
exchange accompanied by a live `Bearer` Nessie access token; every other shape
(password login, local provider, incomplete tuple) is refused before any
upstream exchange or local write. The invariant, in order:

1. **Bearer shape, before any DB traffic:** the bearer must be a live,
   unrevoked `uoa` session whose `uoaIdentity.tokenVersion` is a NON-NULL safe
   nonnegative integer; anything else is refused before the user-row read.
2. **Exchange discriminants, before billing:** the exchanged identity must
   match the bearer on the immutable UOA **subject** (never the possibly
   changed email), return a valid epoch no OLDER than the bearer's (a newer
   returned epoch from a concurrent device renewal is accepted; a regressed
   epoch is refused), and land on exactly the expected organization/team.
3. **Pre-billing fence (read-only):** under the user-session lock, the exact
   first-party Nessie `ProductAccountLink` in the bearer's EXACT local
   organization claim — never an ambient "shared organization" lookup and
   never an email lookup — must still be `linked` to the same subject with a
   non-null safe epoch no newer than the returned one. This read only spares
   a billing POST; it is not the authority.
4. **Billing confirm** (the one network side effect) runs once the fence
   passes.
5. **Authoritative claim, inside the single recovery transaction:** after the
   exact external-workspace advisory lock, the transaction conditionally
   claims that exact link row (`organizationId + userId + productSlug +
   linked + same subject + non-null epoch <= returned`) with `updateMany`,
   advancing its epoch and refreshing the last-seen directory/active tuple.
   The claimed row lock is held to commit; a concurrent epoch advance landing
   between the pre-billing read and the claim makes the claim match zero
   rows and aborts the whole transaction. Only after the claim does the
   transaction read-or-create the target project/team/channel and upsert the
   principal's memberships. A refusal therefore persists NO target,
   membership, session, context, or cookie write — billing alone may already
   have run, which is safe because it is idempotent per exact subject tuple.

Recovery resolves the principal exclusively by the bearer's user id: it never
looks up, creates, or remaps a user by email, and the generic multi-product
link sync is skipped (the in-transaction claim is the only link mutation).

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
**Org and team roles are a projection of the verified UOA claims, re-applied on
every session.** UOA's access token carries `org.org_role` and
`org.team_roles[workspaceId]`; both map through one function
(`api/src/services/uoa-roles.ts` `mapUoaMemberRole`: `owner → owner`,
`admin`/legacy `lead` → `admin`, anything else → `member`) onto the local
`organization_members`, `project_members`, and `team_members` rows. Three paths
carry those claims and all three re-project them, so a UOA promotion or
demotion propagates instead of freezing at first join:

| Path | Claims come from | Effect |
|---|---|---|
| Login (`POST /api/auth/session`, `uoa` branch) | the exchanged access token | `resolveUoaWorkspaceContext` → `ensureWorkspacePrincipal` → `projectUoaRoles` |
| Workspace switch (`POST /api/auth/uoa/workspace`) | the **target** token UOA returned | `materializeUoaWorkspaceSwitch` runs the same login path against the target claims |
| Refresh / rotation (`POST /api/auth/refresh`) | the refreshed access token, threaded through the rotation as `workspace` | `advanceUoaLocalSessionBinding` re-projects inside the family transaction, so the reissued token carries the new role |

Rules that make this safe to run on every session:

- **Only a present claim projects.** An absent `org_role` or a workspace with
  no `team_roles` entry leaves the local row exactly as it was. That is what
  keeps generic (non-UOA) OIDC providers, `local` mode, and the legacy
  no-workspace login byte-identical, and it is the sole surviving case of the
  **first-materializer team-`owner`** rule: whoever first materializes a
  workspace owns its team *only* when UOA sent no role for that workspace — a
  verified claim always wins, including `member`.
- **The projection never removes the last active owner of the shared local
  organization.** Every UOA workspace maps to a Team inside one local
  `Organization`, so a per-UOA-org `org_role` is not a complete statement about
  who administers this Nessie instance — and without the floor the SSO-first
  bootstrap owner would be demoted by their own first login, leaving nobody who
  can administer it. The check runs under the same `FOR UPDATE` owner-row lock
  the local mutators take (`api/src/services/organization-owner-lock.ts`), so
  concurrent demotions serialize. Team roles are not floored.
- Memberships are still **created** create-only (an upsert never resurrects a
  deactivated org membership); role changes come from the projection alone.

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
- `DELETE /api/auth/session` (logout; exact signed Bearer `{sub, sid}`
  revocation, with the ambient cookie ignored)

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

### 4.6 Rosters and invitations are UOA API features in UOA deployments

In a deployment whose provider is UnlikeOtherAI, UOA is the authority for human
identity, organisation/team membership, team rosters, and invitations. Nessie
persists none of it and offers no local substitute:

- **The roster is a live read.** `GET /api/workspace/members` joins UOA's team
  detail (`GET /org/organisations/:orgId/teams/:teamId`, which carries the team
  roles) with the organisation membership list
  (`GET /org/organisations/:orgId/members?status=all`, which carries names,
  emails, and lifecycle status). Every field is display-only; nothing is
  written to a local table.
- **People are matched by UOA subject.** Every route takes the subject in the
  path (`/api/workspace/members/:uoaSub/...`). Never a local user id, never an
  email lookup against local rows — an IdP-asserted email is the documented
  account-takeover shape.
- **The UOA workspace comes from the actor's own session team.** `Team.externalOrgId`
  + `Team.externalWorkspaceId` are the only mapping; a team without both, or a
  deployment with no UOA credentials, answers `404 WORKSPACE_NOT_LINKED`.
- **Invitation acceptance is hosted by UOA.** Nessie creates, lists, resends,
  revokes, approves, and denies invitations; it never mints, stores, or renders
  an invitation token and has no accept page. `deny` covers the
  member-initiated invites still awaiting approval; **revoke**
  (`POST /api/workspace/invitations/:inviteId/revoke` →
  `DELETE /org/organisations/:orgId/teams/:teamId/invitations/:inviteId`)
  withdraws one that was already sent — idempotent, so revoking twice is still a
  success, while an invitation that has already been accepted answers
  `409 INVITATION_ALREADY_ACCEPTED` (that person is a member now; removal is a
  different operation) and an unknown or foreign invite id a generic `404`.
- **Local-mode deployments are unchanged.** Without a UOA session the Members
  page keeps the local list and `POST /api/users`; §4.3a's password bootstrap
  still applies to installs with no IdP.

**Backend mode, and why the local gate is load-bearing.** Nessie holds a bound
UOA refresh credential and deliberately never a spendable end-user access
token, so these `/org/*` calls run in UOA's *backend mode*: the domain-hash
bearer alone, with `X-UOA-Access-Token` **omitted entirely** — a present but
blank header is a malformed credential and answers `401 MISSING_ACCESS_TOKEN`.
Backend mode is opt-in per domain through `org_features.backend_org_management:
true` in the signed config JWT (`api/src/services/uoa-auth.ts`), which is a
second secret in the path: stealing the domain-hash bearer does not turn the
flag on. Backend mode has **no acting user**, so UOA applies no owner/admin
check of its own and records the mutation as `actor_user_id: null` with
`uoa_actor: { via: "domain_backend" }`. Nessie's own owner/admin gate in
`api/src/routes/workspace-members.ts` is therefore the only authorization on
every mutation, exactly as with the workspace avatar relay (§ `docs/done/2026-07-25-uoa-workspace-avatar.md`).
The roster read itself is open to any member of the workspace.

Egress follows the standard rule: `safeFetch` with `maxRedirects: 0` and a
10-second timeout (`@nessie/workspace-admin` `uoa-org-roster.ts`, re-exported
by `api/src/services/uoa-org-roster.ts`). Upstream 4xx becomes
`WORKSPACE_MEMBERS_REJECTED`; a transport failure, 5xx, or unparseable body
becomes `502 UOA_DIRECTORY_UNAVAILABLE` — never a silently empty roster.

**Agents read the same roster.** The personal assistant's `people_search`
(`worker/src/run/pa-tools/people.ts`) calls the same
`resolveUoaRosterWorkspace` + `listWorkspaceMembers` seam — the roster module
lives in `@nessie/workspace-admin` precisely because the worker cannot import
`api/src/services/*`. On a UOA-linked team the tool filters the live roster
(bounded 60-second in-memory cache per org/team) and keys results on the UOA
subject, joining `User.uoaSub` only to surface the local `userId` other tools
take; a failed UOA read is reported in words and never silently answered from
local rows. The local user search remains only for teams that are not
UOA-linked (local mode).
