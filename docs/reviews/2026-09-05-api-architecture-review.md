# API architectural review — 2026-09-05

Findings marked **recorded** below (no code change) are tracked as entries in
[docs/known-limitations.md](../known-limitations.md), which carries the
current file:line evidence and suggested fix for each.

Scope: `api/` (408 source files, 82.6k lines, 249 test files) reviewed against
`AGENTS.md`, `docs/architecture.md`, `docs/standards/*.md` and the UOA identity
invariant. Thirteen reviewers ran in parallel, split by task complexity: two
Haiku passes for mechanical checks, six Sonnet passes for pattern consistency,
five Opus passes for judgment-heavy areas (authorization and tenancy, UOA
identity authority, auth/session/crypto, service cohesion, data layer). Every
finding cited `path:line` evidence; the orchestrator re-verified the ones that
drive a fix before it was scheduled. 88 findings were filed; this document keeps
the ones that describe an architectural inconsistency, grouped by theme.

Status legend: **fixed** — landed in the PR that adds this document;
**follow-up** — deliberate, needs a design or a migration window; **recorded** —
noted in `docs/known-limitations.md`, no code change.

## 1. Authorization is decided by nine vocabularies, and they disagree

The actor model is sound: every request re-resolves the live membership role,
rejects revoked sessions and deactivated members, and the global hook fails
closed. What is missing is one vocabulary for the *decision*. `requireOwner`
(123 sites), `isAdminActor` (3), three inline owner-or-admin spellings,
`canManageChannel`, `requireProjectAdmin`, the `PolicyRule` engine (5 sites)
and per-resource grant tables all coexist, and adjacent routes pick different
ones for the same question.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1.1 | Run cancel/restart/continue are org-scoped only (`services/run-access.ts` `loadRunForOrg`) while the run *list* scopes by agent visibility. Any org member holding a run id can stop or replay a private agent's work in a channel they cannot see. | high | fixed |
| 1.2 | Channel membership is mutable by any channel member (`routes/channels.ts` members routes → `services/channel-members.ts`), while renaming the same channel requires `canManageChannel`. A plain member can evict the channel owner. | high | fixed |
| 1.3 | The org `admin` role has four definitions; `requireOwner` rejects it at 123 sites although UOA projects `admin`/`lead` into it. No `requireOrgAdmin` exists. | high | fixed (helper + the three inline spellings); the per-family audit of the 123 `requireOwner` sites is a follow-up |
| 1.4 | Boards, columns, fields and data sources are gated by `requireProjectAdmin`; iterations on the same surface by `requireOwner`. | medium | fixed |
| 1.5 | Realtime delivery re-checks channel and dashboard scopes per event but not organization, user or agent scopes; thread-scoped SSE re-checks nothing. A removed member keeps a live feed until disconnect. | medium | fixed |
| 1.6 | `routes/mcp/tools.ts` reads `toolGrant` rows with no tenant clause, justified by a comment that is false for the global registry rows the sibling reader deliberately returns. | medium | fixed |
| 1.7 | `routes/team-members.ts` documents a local owner/admin gate before the UOA relay that it does not have; `routes/teams.ts` next door enforces one. | medium | fixed (gate added, decision recorded in `team-model.md`) |
| 1.8 | The `PolicyRule` engine seeds org-wide rules that five checks consult and 123 `requireOwner` sites bypass; its `admin:admin` rules are read by nothing. | medium | recorded |
| 1.9 | `teamId` from the request body is validated against the organisation only, never team membership (`channel-create.ts`, `call-links.ts`); `createCallLinkForTeamUser` has no tenant parameter at all and derives the tenant from caller input. Fixed-UUID sentinel fallbacks in `channels.ts` and `users.ts`. | medium | fixed |
| 1.10 | Device push tokens are transferable across users and tenants by token value; the sibling web-push surface refuses exactly that. | low | recorded |
| 1.11 | `POST /api/approvals/:id/resolve` cannot express the `APPROVER_REQUIRED` refusal its service returns (falls to 400 "Unknown error"). | low | fixed |

## 2. UOA is the authority on paper; the local projection is the authority in code

| # | Finding | Severity | Status |
|---|---|---|---|
| 2.1 | `OrganizationMember` is re-read on every request and *is* the enforcement point, and it is append-only: no code path deletes or deactivates a membership UOA revoked. `DELETE /api/team/members/:sub` relays upstream and writes nothing locally. | critical | fixed (reconcile against the verified UOA directory at session rotation; deny a user actor with no live membership in a UOA-bound org) |
| 2.2 | "Is UOA the authority here?" is answered three ways: `config.mode === 'local'`, the row's own `externalOrgId`/`externalTeamId`, and "is any IdP configured". `teams.ts` uses two of them. `mode: 'local'` with a UOA provider enabled re-opens local membership writes inside a UOA-bound org. | high | fixed (membership gate now reads the acting tenant's binding); password-path gating stays on `mode`, follow-up |
| 2.3 | Two doors create a team: `POST /api/teams` (and the `team_create` agent tool) creates an unbound local `Team` + `TeamMember` with no relay; `POST /api/teams/teams` relays with a subject assertion. | high | fixed (local door refuses inside a UOA-bound org and points at the relay) |
| 2.4 | The generic-OIDC login path still lands on the ambient oldest organization / oldest team, which on a UOA install are UOA-owned rows. | high | fixed (fallback refuses bound rows) |
| 2.5 | UOA invitation data (`teamName`, `invitedBy`) is persisted into `UserAlert.metadata` three lines after a comment saying UOA directory data is never durable. | medium | fixed (rule amended to name the bounded, self-reconciling exception) |
| 2.6 | `docs/standards/scoped-settings.md` states the tree as Organisation → Project → Team, the opposite of `team-model.md` and of the shipped secrets cascade. | medium | fixed (doc) |
| 2.7 | The UOA avatar relay skips the mirror refresh that team and org renames perform. | low | fixed |

## 3. Auth, session and key material

| # | Finding | Severity | Status |
|---|---|---|---|
| 3.1 | `NESSIE_AUTH_SECRET` is one root key for ~10 purposes with no domain separation: `deriveSecretKey` is bare `sha256(secret)`, so one AES key encrypts UOA refresh tokens, MCP OAuth tokens, mailbox and push credentials and webhook secrets, while the same string HMACs session tokens and executor challenges. `keyVersion` columns exist on three tables and are read by nothing. Config accepts a one-character secret. | critical | follow-up — needs a keyed derivation *and* a re-encryption migration; changing the derivation alone bricks every ciphertext |
| 3.2 | Three session-revocation authorities are checked per request (`tokenVersion`, `AuthSession`, live refresh row); the registry documents itself as the sole authority and is fail-open on absence. | high | follow-up — consolidation needs a proof that issuance covers every path |
| 3.3 | Two rate limiters: an in-process `Map` in `lib/rate-limit.ts` on the global hook (raw IP, hard-coded rules, per replica) and a Postgres-backed, audited, config-driven one in `services/rate-limit.ts`. The same login route is limited twice with the same numbers and different IPv6 keying. | high | fixed (one limiter; rules moved to config buckets; check moved to `onRequest`) |
| 3.4 | `DELETE /api/auth/session` never reads or clears the refresh cookie and returns 204 when the bearer is missing, leaving a live 30-day credential in the browser. | high | fixed |
| 3.5 | `createServerContext()` runs at module import in `index.ts`, opening the DB pool and calling `process.exit(1)` before any handler exists — the guardrail `docs/architecture.md` names. | medium | fixed |
| 3.6 | Rate limiting and auth run at `preHandler`, after the body is buffered and parsed. | medium | fixed |
| 3.7 | Rate-limit coverage is per-call-site opt-in: six of seven executor-daemon routes, every webhook intake and `GET /api/auth/me` are unlimited; `POST /api/triggers/webhook` scans every tenant's webhook triggers per request. | medium | fixed (default bucket for public routes; webhook key looked up by hash) |
| 3.8 | Session issuers discard the claims they built, so six routes re-verify the token they just minted and carry an unreachable 500 branch. | low | fixed |
| 3.9 | Bootstrap token state is per-process and compared with `!==`. | low | fixed (timing-safe compare); multi-replica bootstrap recorded |
| 3.10 | Four hand-rolled HMAC verifications with divergent encodings; only one applies domain separation. | medium | fixed (one shared verifier in `@nessie/runtime`) |

## 4. Service layer: forked concepts

| # | Finding | Severity | Status |
|---|---|---|---|
| 4.1 | Nine entry points create a `Message` row; one runs the invariants (follow, mention alerts). `message.new` is hand-built at six sites, and `routes/voice-call-record.ts` sends `role: 'agent'`, which is not in `MessageRoleSchema`, so the event throws and a bare `catch {}` swallows it. That realtime event has never fired. | high | fixed (`publishMessageNew` owns the envelope; the bare catch logs) |
| 4.2 | The cost ledger decides whether a connector call is billed by a four-way metadata-spelling OR, copy-pasted twice, because `ConnectorUsageEvent.metadata` has no schema. | high | fixed (metadata parsed at the write door; one predicate) |
| 4.3 | `continueRun` and `resumeSuspendedRun` implement the same six-step continuation with the actor-context wrapping order inverted and only one applying the disclosure basis check. | medium | fixed (`resumeSuspendedRun` is the single owner) |
| 4.4 | `orchestrate.decide` has two enqueue implementations; the worker's `send_message` tool stamps delegated-DM identity from the *current* run rather than the destination and does not recognise `system_agent`. | high | fixed (shared `enqueueOrchestrateDecide`) |
| 4.5 | Two `queue_jobs` enqueue primitives with different idempotency semantics inside the worker; `budget.alert-dispatch` is a bare literal. | medium | fixed |
| 4.6 | Advisory locking has no owner: ~46 sites across two mutually invisible Postgres lock namespaces and two key conventions. | medium | follow-up — a single owner and a one-deploy conversion |
| 4.7 | Three modules under `services/` take `FastifyReply` and write HTTP bodies; one imports upward from `../routes/`. | medium | fixed (moved to `routes/`) |
| 4.8 | Twelve pure re-export shims in `services/`, four byte-identical, three renaming on the way through. | medium | fixed (deleted; importers use the package) |
| 4.9 | Eighteen files exceed the 500-line cap; five services have clear seams (`inference-control-plane.ts` is four CRUD families, `messages.ts` is read model + read state + mutations and forms an import cycle with `message-create.ts`). | medium | fixed for those five services; the route-file splits are a follow-up |
| 4.10 | No single convention for a service reporting a domain failure: 31 result-union modules, 39 error-class modules, three status-carrying classes, two reply-writing modules. | low | recorded |
| 4.11 | A dead duplicate of the tenancy rule `validateWorkflowRunReferences` in `api/` beside the live `@nessie/team-admin` copy. | high | fixed (deleted) |

## 5. Routes owning workflows, and validation with three conventions

`dashboards.ts`, `threads.ts` and `executors.ts` are the shape to converge on
(parse → service → map errors). The offenders are single handlers that inline a
read → decide → write → publish sequence.

| # | Finding | Severity | Status |
|---|---|---|---|
| 5.1 | Input validation: 353 `parseInput` (zod) sites, 24 direct `.safeParse`, 14 raw `request.body as {...}` casts, 287 hand-cast `request.params`. `projects.ts` uses two styles a few lines apart. | high | fixed for the raw body casts; params are a follow-up (mechanical, ~70 files) |
| 5.2 | Disclosure-grant workflow (audience validation, duration cap, upserts) lives in a 205-line route handler. | high | fixed |
| 5.3 | Voice tool-call idempotency + spend cap + transactional write inlined in the route while every sibling delegates to `voice-session.ts`. | high | fixed |
| 5.4 | `POST /api/auth/switch-context` inlines a 115-line membership/SSO workflow with an unvalidated body. | high | fixed |
| 5.5 | `secrets.ts` copy-pastes the manage/delegate authorization predicate three times. | medium | fixed |
| 5.6 | `browser-cloud.ts` re-implements `loadViewableSession` inline in one route. | medium | fixed |
| 5.7 | Upload-then-create-with-rollback duplicated in `knowledge-base-files.ts`. | medium | fixed |
| 5.8 | `team-provisioning.ts` defines the idempotent provisioning transaction at route scope. | medium | fixed (moved beside the UOA roster service) |
| 5.9 | Audit emission is 88 route-side calls vs 8 service-side; whole families never audit (channels, member invitations, trigger lifecycle, MCP instance/credential writes, scoped settings). | high | fixed for the named families; the "audit travels with the mutation" direction is recorded in `docs/architecture.md` |

## 6. Errors and contracts

| # | Finding | Severity | Status |
|---|---|---|---|
| 6.1 | No `setErrorHandler`: an escaped error produces Fastify's default envelope, which the shared client cannot parse, and `routes/devices.ts` interpolates the request's push token into such a message. | high | fixed |
| 6.2 | "Target user is not in this organisation" is 404 in projects/teams, 403 in channels, 400 in tasks. | high | fixed (one helper, one status) |
| 6.3 | `designer.ts` and `agent-email-inbound.ts` send `{error: "string"}`, which the admin renders as raw JSON. | medium | fixed |
| 6.4 | Seventeen route files match `error.message === 'CONSTANT'` against bare `Error` throws beside ~50 typed error classes. | medium | fixed for the api-local services; `auth-security.ts` follows in 5.4 |
| 6.5 | `If-Match` wired for 3 of the revision-bearing resources; `AgentTodoTemplate.version` exists and its PUT is last-write-wins. | medium | fixed |
| 6.6 | Approval gates have no schema on either side of the wire; the admin's hand type is already missing six fields the server returns. `SecretRecord` likewise. `UserAlertRecordSchema` gained `callId` server-side and the admin never saw it, so missed-call alerts have no click-through. | high | fixed (record schemas moved to `@nessie/schemas`, admin imports them) |
| 6.7 | `api/src/contracts.ts` barrel omits 4 of 26 domain files; 77 importers use the barrel, 11 bypass it. | medium | fixed (barrel removed; per-domain imports) |

## 7. Data layer

| # | Finding | Severity | Status |
|---|---|---|---|
| 7.1 | `DELETE /api/projects/:id` guards on channel count and hard-deletes; the FK cascade takes the whole knowledge base (which has its own `deletedAt`), every UOA-mirrored `Team` and its memberships without telling UOA, and `Executor` is `Restrict` so it 500s instead of 409. | critical | fixed (`deleteProject` service enumerates blocking families, maps P2003) |
| 7.2 | `Team` has no `organizationId`; tenancy is a `project: { organizationId }` join restated at ~29 sites with two near-identical helpers. | high | recorded; the FK inversion is already planned |
| 7.3 | Disclosure grants resolved per row in both hot message reads, one serially, one over an unbounded candidate set. | high | fixed (batched accessor, bounded candidates) |
| 7.4 | External HTTP inside interactive transactions holding row locks (`comms-credential-coordinator.ts`), no `connection_limit`. | medium | fixed (refresh outside the transaction, compare-and-swap re-entry) |
| 7.5 | `AgentTrigger` by-id service functions take no `organizationId` while the list function beside them does; ~49 bare `findUnique` by caller-supplied id in services. | medium | fixed for triggers; the wider sweep is a follow-up |
| 7.6 | Ledger rows survive org deletion by design; audit logs and budget alerts cascade; the BudgetAlert comment describes a shape the schema no longer has. | medium | comment fixed; retention decision recorded |
| 7.7 | `resource_locks` has three REST endpoints and zero internal callers; `docs/the-agents.md` says agents use it; release is not owner-scoped. | medium | fixed (owner-scoped release); the wiring or removal is a product decision, recorded |
| 7.8 | `TaskBoardPlacement` can point a task at a column of a different board. | low | fixed (composite FK migration) |
| 7.9 | A created message's agent-mention metadata is written outside the transaction that created the message. | low | fixed |

## 8. Tests and structure

| # | Finding | Severity | Status |
|---|---|---|---|
| 8.1 | Two api tests import `../../worker/src/...` directly instead of the package export. | medium | fixed |
| 8.2 | 96 of 149 route modules have no test importing them, including executors, agent-mailbox and app-connection-requests. | high | recorded |
| 8.3 | 147 `as unknown as PrismaClient` fakes; at least one models 2 of the 10 delegates its subject uses. | medium | recorded |
| 8.4 | Six dead exports in a sample of fifteen; fifteen `as unknown as Prisma.InputJsonValue` casts. | low | fixed (dead exports removed; one `toInputJson` owner) |
| 8.5 | `file-storage.md` names "attachment-linking" as a `FileService` operation the service does not have; `team-model.md` cites a file that does not exist; `personal-assistant-tools.md` contradicts itself on where `project_list` lives. | low | fixed (docs) |

## What was confirmed correct

Recorded so the next review does not re-derive it: trust-proxy defaults off;
CORS team-host matching is label comparison; the UOA refresh token is
encrypted, family-scoped and rotation-enforced; refresh-token reuse detection is
one design; WebSocket auth reuses the HTTP path and is not a CSRF surface;
approvals apply one visibility predicate to list, get and resolve; tasks, secrets
and disclosure grants bind body ids to proven-in-tenant resources; agent edit
authority follows `agent-ownership.md`; every "one per (org, x)" concept is a real
DB constraint; every claim-once path is a conditional `updateMany`; raw SQL is
parameterised; `EMBEDDING_DIMENSIONS` is respected; multi-replica realtime
fan-out is genuine LISTEN/NOTIFY; the trigger, team-context, deepwater, push and
billing clusters are decompositions, not forks; dependency injection is clean
(zero Prisma singletons, zero import-time env reads in `services/`).
