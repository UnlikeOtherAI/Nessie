# Security boundary hardening — system design (2026-08-13)

Status: design under external review (Kimix, Codex Sol); implementation not
started. Input findings: the security addendum (S1–S14) of
[2026-08-13-architecture-audit.md](2026-08-13-architecture-audit.md), all
verified against the tree.

## The problem, precisely

Nessie already owns good security primitives — `safeFetch`, `canManageChannel`,
the deny-default policy evaluator, the encrypted secret store,
`findThreadForUser`, `resolveActingMember`. Every finding in S1–S14 is the same
event: a call site that *could* have used the primitive and didn't, because the
primitive is a convention invoked per call site rather than a boundary the code
cannot cross unknowingly. New surfaces re-decide the question and sometimes
decide wrong (channel members route), copy the primitive and drift (worker
policy evaluator, pa-tools `canManageChannel`), or never meet it (inference
connectors' raw `fetch`).

**Design principle: every security decision gets exactly one owner, and the
bypass becomes mechanically detectable.** Three levers, applied per workstream:

1. **Chokepoint APIs** — one function owns the decision; callers cannot make a
   weaker version of it because they no longer hold the ingredients.
2. **Lint/type enforcement** — the unsafe spelling (`fetch(`, `prisma.` in
   routes, env-name secrets in contracts) fails lint with a shrinking
   grandfather list, so regression is a CI failure, not a review catch.
3. **Boundary regression tests** — each boundary gets a test that fails if the
   boundary weakens (two-org tenancy, redirect credential retention, revoked
   member on an open stream), pinning behaviour independent of implementation.

Nothing here invents new infrastructure; every chokepoint below is an existing
in-repo pattern promoted to mandatory.

---

## Workstream 1 — Tenancy and session integrity (S1, S9)

### 1a. One session-context resolver

New `resolveSessionContext(prisma, userId, selected?)` in
`@nessie/workspace-admin` (beside `checkPolicy` and the access predicates):

- Loads the **active** org membership for `selected.organizationId` (or the
  user's only/default org), then verifies `project.organizationId === org` and
  `team.projectId === project` before returning the tuple + live role.
- Absent or incoherent selection resolves to the org's defaults **via the same
  hierarchy walk** (org → its default project → its default team), never by
  element-zero of three independent lists (the S1 defect in
  `api/src/services/session-issuers.ts:30-56`).
- Sole caller for login issuance, refresh re-issuance, and
  `POST /api/auth/switch-context` (which today holds the only correct copy of
  the hierarchy check — that copy moves into the resolver).

### 1b. Bind the selection to the refresh family

`RefreshToken` gains nullable `selected_project_id` / `selected_team_id`
(migration). Refresh replays the stored selection through the resolver instead
of rebuilding from membership lists; switch-context updates the stored
selection on rotation. A selection that no longer validates (project deleted,
membership revoked) degrades to org defaults — it never passes through
unvalidated.

### 1c. Membership writers revalidate inside the transaction

Shared `assertTenantHierarchy(tx, {organizationId, projectId?, teamId?})` in
`@nessie/workspace-admin`, called inside the transaction by
`createUserForOrganization` (`api/src/services/users.ts:275-320`) and the
project/team member mutation routes. The session tuple is treated as a *claim*,
not a fact, at every write.

### 1d. Database backstop — make the incoherent state unrepresentable

Raw migration adding composite foreign keys: unique `(id, organization_id)` on
`projects` and `(id, project_id)` on `teams`, then
`project_members(project_id, organization_id) → projects(id, organization_id)`
and `team_members(team_id, project_id) → teams(id, project_id)` (denormalizing
the parent ids onto the membership rows). Pre-migration validation query lists
any existing incoherent rows for manual disposition before the constraint
lands. This is the "harder to represent" backstop S1's fix asked for —
after it, 1a–1c are defense in depth rather than the only line.

### 1e. Per-session revocation (S9)

Access JWTs already carry `sessionId` (`session-issuers.ts:27,74`); make it
required for user sessions. Central auth (`server-context.ts`, beside the
existing `tokenVersion` check) rejects a token whose session is revoked:
source of truth is the refresh family (`RefreshToken.sessionId` +
`revokedAt`), read through a small in-process TTL cache (~30 s) so the hot
path stays one cached lookup. `DELETE /api/auth/sessions/:id` and password
change then genuinely end the session within the cache TTL instead of leaving
a ~30-minute access-token tail. (Logout's `tokenVersion` bump stays as the
global kill switch.)

**Tests:** a two-organization regression suite — login, refresh,
switch-context, `POST /api/users`, and each membership writer attempted with a
cross-tenant tuple; plus revoked-session and password-change token-rejection
tests.

---

## Workstream 2 — Secret custody (S2, S13)

### 2a. One scoped secret-material store

Promote the crypto+store pattern to a purpose-aware chokepoint (new
`@nessie/secret-store`, or a named module in `@nessie/runtime` beside
`secret-crypto.ts` — decide by whether api and worker both need writes; they
do, so a package). Table `secret_material`:

```
ref (pk) · ciphertext · iv · auth_tag · purpose (enum: mcp_oauth, inference,
push_platform, dashboard, comms) · organization_id (nullable) ·
owner_user_id (nullable) · created_at · updated_at
```

API: `store({purpose, organizationId?, ownerUserId?}, plaintext) → ref` and
`resolve(ref, expected: {purpose, organizationId?})` — resolve **fails on any
scope mismatch**, and the genuinely platform-global purposes (`push_platform`)
must say so explicitly. Migration moves `McpOAuthSecret` rows in (purpose
`mcp_oauth`, org backfilled from the owning instance), retires the duplicate
push store implementation (`api/src/services/push-secret-store.ts`), and makes
the dashboard adapters' ignored organization argument load-bearing.

### 2b. Inference credentials stop being environment names (S2)

- Remove `authSecretRef` (an operator-typed `process.env` name) from the
  public contract (`api/src/contracts/inference-control-plane.ts:97`).
  Replacement mirrors the MCP rule the repo already documents: plaintext is
  submitted once, stored via 2a with `{purpose: 'inference', organizationId}`,
  and only the server-minted ref is persisted; responses return presence only.
- Environment references survive **only** on the exact internal allowlist
  pattern (`packages/mcp-manage/src/secret-resolver.ts:27-51` is the
  template), reachable solely from first-party provisioning code, never from a
  request schema.
- Worker resolution (`worker/src/run/inference-provider.ts:79-80`) goes
  through `resolve(ref, {purpose: 'inference', organizationId})` — a foreign or
  repurposed ref fails closed.
- Migration: existing env-ref bindings are enumerated by a script; each is
  either re-entered as plaintext by the operator or pinned onto the internal
  allowlist explicitly. Startup logs any binding that resolves to nothing.

**Tests:** resolve-with-wrong-purpose and wrong-org fail; contract rejects
env-shaped refs; the worker path never touches `process.env` for org
providers.

---

## Workstream 3 — Egress: one credential-aware transport (S3, S4, S8 + audit finding 2)

### 3a. Credential-aware redirect policy inside `safeFetch`

`packages/runtime/src/url-safety.ts` becomes the *only* place redirect policy
exists:

- New option `redirectPolicy: 'follow' | 'same-origin' | 'none'`.
- `safeFetch` inspects the outgoing request at entry: if it carries
  credential-shaped headers (`authorization`, `cookie`, `x-api-key`,
  `proxy-authorization`, the `X-Nessie-Context`/`X-UOA-Delegation` identity
  headers), the *default* becomes `same-origin` — following a cross-origin
  redirect with those headers requires an explicit opt-in that also **strips
  the credential headers and rewrites method/body per the standard rules**.
  This closes S4 (today the manual loop replays the original `init` on every
  hop) once, for every caller: MCP transports, `http_fetch`'s one-hop
  redirect, comms, everything.
- `packages/dashboard/src/source-fetch.ts` (`maxRedirects: 0`) already models
  the strict end of this policy and keeps working unchanged.

### 3b. Connectors dial through an injected pinned fetch (S3)

The inference connector interface gains `fetchImpl` (injected by
`createModelClient` as `safeFetch` with `redirectPolicy: 'none'` and
revalidate-on-use); `openai.ts`/`kimi.ts`/`minimax.ts` lose all references to
global `fetch`. Deployment and org provider URLs are revalidated at dial, not
only at write. Nessie's own public origins join the deny-set alongside private
ranges.

### 3c. The remaining bare-fetch call sites move over

- Web Push: `packages/push/src/webpush.ts` takes the secure transport as its
  default rather than an optional injection; the worker's one-shot
  `sendWebPush` path uses it (S8).
- OIDC login: `api/src/services/external-auth.ts` discovery/token/userinfo go
  through pinned fetch, and discovery-supplied `token_endpoint` /
  `userinfo_endpoint` must share the issuer origin (audit finding 2 / Kimix
  A2). `uoa-session.ts` token exchange + directory read likewise (env-derived
  host, but no reason to stay outside the seam).
- OIDC issuer config validation upgrades from `z.string().url()` to the SSRF
  guard at config load.

### 3d. Enforcement

ESLint rule (custom or `no-restricted-globals` variant) banning bare `fetch(`
in `api/src`, `worker/src`, and `packages/*/src`, with an explicit allowlist
file for the few legitimate sites (e.g. the pinned dispatcher internals
themselves). The allowlist is the ratchet: additions require review, and the
current bare sites are burned down workstream by workstream.

**Tests:** cross-origin 302/307/308 with `Authorization` set → header absent
or request refused, on `safeFetch`, the MCP transport, `http_fetch`, and web
push; DNS-rebind simulation on the webpush path (resolve-once assertion).

---

## Workstream 4 — Entitlement chokepoints (S5, S6, S7, S10; audit finding 1)

### 4a. Channel management moves into `@nessie/workspace-admin` — once

`canManageChannel` and the visible-channel where-builder move from
`api/src/services/channels.ts` / `worker/src/run/pa-tools/access.ts` into
`@nessie/workspace-admin` (the api service re-exports, per the established
pattern). The worker's forked copy in `pa-tools/channels.ts` — the one with
the documented anti-pattern comment *and* the missing `deactivatedAt` check
(S10) — is deleted; pa-tools channel operations call the shared actor-aware
functions, resolving the live acting member first (`resolveActingMember`
already does this correctly).

### 4b. Actor-aware channel membership mutation (S5)

New `addChannelMember(actor, channelId, targetUserId)` /
`removeChannelMember(...)` in workspace-admin: canManageChannel +
`checkPolicy(channel, manage)` + active same-org target + last-manager
protection + audit event, all in one transaction. The routes
(`api/src/routes/channels.ts:349+`) shrink to parse/call/map; the admin UI's
owner-only "Add people" affordance becomes honest instead of load-bearing.

### 4c. `loadRunForActor` (S6)

Replaces `loadRunForOrg` (`api/src/services/run-access.ts`): org scope **plus**
the same channel entitlement as thread reads (`findThreadForUser`) **plus** PA
ownership (a PA run is visible only to its owner). Used by list, cancel,
restart, and continue (continue already does this — its check becomes the
shared one). `GET /api/runs/active` filters by the caller's entitled channels
using the same where-builder from 4a. If an org-wide operator view is wanted
later, it is an explicit owner-only surface, not the member default.

### 4d. Thread SSE authorizes per event (S7)

`ThreadSseConnection` (`api/src/realtime/hub.ts:17-28`) gains
`userId`/`organizationId`; fan-out applies the same `canAccessChannelEvent`
check user SSE/WS already run per event, and backlog hydration checks too.
Membership revocation additionally publishes a close for matching connections
(cheap, immediate), but the per-event check is the boundary — revocation
correctness must not depend on the disconnect race.

**Tests:** member-not-manager cannot mutate membership; org member without
channel access cannot list/cancel/restart the channel's runs and never sees PA
runs; an SSE stream opened before revocation receives nothing after it.

---

## Workstream 5 — One policy engine, one origin resolver (S11, S12)

- **Policy:** the worker's tool evaluator
  (`worker/src/run/execute/policy.ts:144-215`) is replaced by the
  `@nessie/workspace-admin` evaluator. If tool invocation is *intended* to
  default-allow when no rule matches (the registry/grant gate runs first), that
  becomes an explicit, named mode — `evaluate(…, {defaultVerdict: 'allow'})` —
  with a test asserting both engines share one implementation and the mode is
  visible at the call site. Opposite silent defaults for one vocabulary is the
  latent bypass; the mode makes the difference deliberate.
- **Origin:** one `resolvePublicOrigin(request, config)` helper: configured
  public URL wins; otherwise Fastify's trusted-proxy-scoped
  `request.protocol`/`hostname`; never raw `x-forwarded-*` headers. MCP OAuth
  (`api/src/routes/mcp/oauth.ts:58-62`) and comms
  (`comms/oauth-config.ts:101-105`) both use it. Tests cover spoofed forwarded
  headers at 0 and 1 trusted hops.

---

## Workstream 6 — Contract authority (S14)

`api/src/contracts/inference-core.ts` stops duplicating
`packages/schemas/src/inference-core.ts` and re-exports it (the two have
diverged in validation strength: `imageUrl` `min(1)` vs `.url()`, missing
`reasoning_text.delta`). A conformance test asserts the api contract surface
is the schemas surface. This is the same move the wider audit prescribes for
client-core; it is listed here because divergent *validation* strength is a
security property, not just wire drift.

---

## Sequencing

| Phase | Contents | Size | Rationale |
| --- | --- | --- | --- |
| 1 | 4a–4c (channel mgmt + run access chokepoints), 5 (policy + origin), S10 fork deletion | days | Highest impact-to-effort; pure consolidation onto existing primitives; no schema changes |
| 2 | 3a–3d (egress: redirect policy, connector injection, webpush, OIDC, lint ratchet) | ~1 week | One package owns it; mechanical call-site migration behind the lint list |
| 3 | 1a–1e (session resolver, refresh binding, membership writers, composite FKs, per-session revocation) | ~1 week | Schema migrations + auth-path changes; wants the phase-1 test harness in place |
| 4 | 2a–2b (scoped secret store, inference credential migration), 4d (SSE per-event), 6 (contract) | ~1 week | Store migration touches three subsystems; SSE change is isolated but wants soak time |

Each phase lands with its boundary tests and its lint additions in the same
change (repo rule: enforcement ships with the capability).

## Risks and compatibility

- **`authSecretRef` removal is a breaking API contract change.** Gate: accept
  both shapes for one release, log deprecation on env-shaped writes, migrate,
  then remove. Ledger-routed deployments are unaffected (the binding is
  already suppressed there).
- **Composite-FK migration** needs the pre-validation pass on live data;
  incoherent rows are quarantined for manual disposition, never silently
  deleted.
- **Per-event SSE checks** add a query per event per connection; the user
  SSE/WS path already pays this and is fine, and the TTL-cached membership
  lookup keeps it flat.
- **Redirect-policy default change** could break a legitimate connector that
  redirects cross-origin with credentials; the explicit opt-in (with header
  stripping) is the escape hatch, and the lint allowlist makes each such site
  visible.
- **Embedded-worker import order** (audit finding 9) interacts with workstream
  2/3 wiring; the composition-root cleanup should land first or alongside.

## Review

This design goes to Kimix and Codex Sol for independent review (adversarial:
find the bypass the design misses, the boundary that is still a convention,
the migration that breaks a live deployment). Their verified feedback lands as
amendments here before implementation starts.
