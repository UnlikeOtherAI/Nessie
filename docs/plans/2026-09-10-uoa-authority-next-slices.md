# UOA authority completion — staged handoff

Status: planned, not implemented. Owner: Sol. This continues item 11 of the
[review follow-through](2026-09-09-review-followthrough/overview.md) and the
[UOA unification design](2026-09-02-uoa-as-a-service-unification.md).
The missing contracts are implementable work in UnlikeOtherAuthenticator,
not an external service blocker. The active directory slice shipped in PR 444;
it does not complete the identity or hierarchy migration.

## Boundaries and selected defaults

- UOA owns identity, profiles, organisations, teams, their membership, roles,
  invitations and revocation. Nessie retains stable references and product data.
- Bound-mode authorization must stop reading durable UOA membership copies.
  Explicit no-IdP organisations retain local identity management.
- Product directory access uses a purpose-bound credential with explicit grants
  to exact organisation IDs. Do not reuse domain, billing or user credentials.
  UOA organisation owners create/revoke grants; existing tenants get no implicit grant.
- Background access receives hierarchy, standing and permitted display summaries,
  without email. Interactive email reads retain UOA's live caller permissions.
- Remove UOA-derived `ProjectMember` projections. Restricted projects intersect
  live org/owning-team standing with independently product-owned project/board
  grants. Audit those grants separately; they never substitute for UOA standing.
- Webhooks/deltas carry invalidation facts. Nessie stores cursors and credential
  epochs, never the returned profile or membership payloads.
- Order changes through per-organisation transaction advisory locks held across
  mutation, revision allocation, outbox insertion and commit. Never use timestamps
  or an unprotected insert sequence as the published order.

## U1 — credentials, grants and the change outbox

Create a directory credential bound to an active UOA `ClientDomain`, with a
one-time secret stored as a digest, explicit expiry/revocation and bounded
rotation overlap. Exact-org grants distinguish membership read, display-summary
read and webhook management. Re-read the active credential/grant on each call.

Add an organisation revision and an outbox unique on `(orgId, revision)`.
One mutation seam resolves all affected organisations, locks their IDs in sorted
order, performs the write, increments revisions and inserts minimal events in
the same transaction. Profile changes affecting multiple organisations use the
same ordering. Rollbacks publish nothing; deletion retains its terminal event.

Cover every writer: org/team CRUD and ownership transfer, direct member/role
changes, activation/removal, invitation acceptance, self-join and automatic enrolment.
Inventory the actual call sites before declaring this seam complete.

Home: UOA organisation settings' product-access controls, with grant/revoke actions
and a connection-setup doorway. Raw outbox/revision storage is machine-only.
Tests prove exact-org denial, revocation, rollback, concurrent commit ordering,
multi-org deadlock avoidance and each mutation family's event.

## U2 — snapshot, delta and delivery

Add versioned directory snapshot/change routes and webhook registration,
rotation and disable operations under the U1 grants. A snapshot reads under the
corresponding shared transaction lock and returns one consistent high-water
revision. Delta pages have an exclusive cursor, stable upper bound and explicit
expired-cursor response. An expired cursor requires a new snapshot.

Payloads contain only fields allowed by the grant. Events contain IDs, revision,
kind and occurrence time, with no profile text. Webhook delivery is durable and
at least once, with bounded retry, an event/subscription idempotency key and HMAC
over the exact body. Rotate signing material with an explicit overlap. Follow
the service's outbound egress policy for callback registration and delivery.

Home: the U1 connection controls expose delivery health and repair. Delta and
snapshot reads are machine-only integration contracts. Test pagination, deletion,
snapshot/delta agreement, restart, duplicate/out-of-order delivery and rotation.

## U3 — authoritative profile reads and writes

Implement UOA's specified `GET/PATCH /profile/me` for supported profile fields,
plus exact member display summaries. Support Nessie's BFF through a short-lived,
audience-bound subject assertion with live UOA authorization; do not replace it
with the background credential. Email change remains a separate verified flow.

Profile writes emit U1 invalidations. Background summaries omit email and
authentication factors. Home: existing profile settings and member surfaces;
update UOA's API schema, LLM docs, profile specification and permission tests.
An unresolved or erased subject defaults to neutral presentation in Nessie.
Any UOA policy retaining former-member names/avatars needs an explicit retention
decision; Nessie must never archive the last known profile as a substitute.

## N1 — one shared live authority boundary

Refactor `packages/runtime/src/uoa-live-entitlements.ts` and
`api/src/services/uoa-identity-directory.ts` into one shared owner. It supports
interactive/background standing, hierarchy, self profile and permitted directory
reads. Keep current cache entry/member/in-flight bounds, short freshness deadlines,
credential epochs and generation fencing; an expired read fails closed.

Persist only per-org observed revision, reconciled cursor, credential epoch and
health. Verify webhook raw bodies, advance observed revision and enqueue an
idempotent reconciliation. Every replica checks the durable generation before
reusing memory. A claimed periodic delta sweep recovers missed delivery and can
refresh a snapshot without durably copying it. Capability failures expose an
explicit remedy through the existing integration-health surface.

Prove cross-replica invalidation, grant revocation without login, upstream outage,
bounded cache use, duplicate delivery and cursor recovery before switching authority.

## N2 — move readers and product attribution

Migrate request admission, context switching, project access and realtime delivery
first; then shared packages, disclosure, worker dispatch, triggers, workflows,
approvals and PA tools. Require current UOA standing while preserving verified
product-owned permissions. Deny-only product suspensions never grant membership.

Move auth/me, message/activity/call/alert/DM/push displays and owner selectors to
the same directory boundary. Replace product foreign keys to `OrganizationMember`
with a stable attribution anchor containing no role or membership state. Include
agent ownership, subscriptions, settings, browser grants and mailbox ownership.
Each slice must update all of its API, worker and UI callers together.

## N3 — stop mirrors and finish the hierarchy contract

Stop bound-mode writers in `team-principal.ts`, `uoa-profile-mirror.ts`,
`uoa-refresh-coordinator.ts`, `uoa-roles.ts`, `uoa-session-context.ts`,
`external-organization.ts`, `team-target.ts` and organisation/team/avatar routes.
Retain genuinely local-mode writers behind the explicit no-IdP boundary.

Audit with `scripts/inspect-team-shape.sql`; halt on ambiguous, orphaned,
multi-team or cross-tenant rows. Backfill `Project.teamId`, migrate all readers,
enforce tenant coherence, then remove `Team.projectId` and fabricated anchors.
Handle `systemManaged`/`channelRoot` containers explicitly; real project names
remain Nessie-owned. Remove bound profile/name copies, redundant `Team.externalOrgId`
and UOA-derived membership rows only after the caller/FK inventory is empty.
Use nullable local-only fields or a local identity extension for no-IdP data.

## Remaining writer inventory and rollout

The [audited inventory](2026-09-02-uoa-as-a-service-unification.md#nessie-storage-and-call-site-audit)
remains the source of truth. Key stores are `User.email/displayName/avatarUrl`,
`Organization.name`, `Team.name/externalOrgId` and mirrored memberships. Also
remove `uoa-directory-cache.ts`'s durable fallback and `team-target.ts`'s legacy
overwrite of anchor-project names. Stable subjects, product bindings and audit
references stay; none grants membership by itself.

Implement in fresh worktrees against current remote main, using isolated Postgres
and each repository's required checks. Deploy U1, then U2/U3; provision explicit
grants and rotating secrets; deploy N1 and prove health; migrate N2 consumers;
audit/backfill; finally contract N3. Do not combine old and new authorities into
an allow-if-either rule. Stop the cutover if required grants, data evidence or
health are missing. Production data/credentials are not needed to implement or
test the upstream contracts, but are needed for the actual rollout.

Acceptance includes clean install and real upgrade fixtures, preserved product
records, no durable bound identity copies, no local membership authorization,
intact no-IdP behavior, and headless login/switching/member/project flows.
