# Authorization, data and disclosure architecture

Part of the [cross-organisation sharing plan](overview.md).
Names marked **new** below are proposed symbols, not existing APIs.

## 1. One access decision, two distinct contexts

Keep authentication and `ActorContext.tenant` in the recipient organisation.
`createRequestAdmission` / `authorizeUoaRequest` continue verifying the actual
session and epoch. Never replace that tenant with the source org to satisfy a
downstream equality check. The source resource context is a separate server-derived
value, carried alongside actor provenance and any separately admitted billing origin.

Add **`resolveResourceAccess(actor, target, action)`** in the smallest shared domain
owner, `@nessie/team-admin`, behind injected live-entitlement and policy readers.
Factor native access through it without changing native semantics. It returns a
discriminated `native | shared | denied` result; no source-org `isAdmin` boolean
is inherited from a recipient role. For a shared result return:

- Actual actor subject/local stable user reference, recipient organisation, exact
  granted team, credential epoch and live proof freshness.
- Canonical source organisation/project/team and, for a board, its exact id.
- Explicit operations, field/resource projection and eligible board set.
- Authorizing grant id/revision/expiry and policy revision; when alternatives
  exist record one complete selected authority, not a union of partial powers.

This is request-local validated context, never a serialized bearer the client can
replay. Shared DTOs return safe capabilities for rendering; services resolve fresh
authority again. Do not add foreign project ids to an unqualified
`listAccessibleProjectIds` or return its administrator sentinel `'all'` across
tenants. Use qualified targets `(sourceOrganizationId, resourceType, resourceId)`.

Shared allow requires **all** of: authenticated current subject; live recipient
org membership; exact live recipient-team membership; active accepted unexpired
grant; proven source resource ancestry; live resource/not deleted; source and
recipient sharing policy/eligibility; allowed action; resource projection; and
all content disclosure conditions. RO never gains a mutation from read reach.
Source `public` project visibility means public inside its organisation only.

Resolve live membership with `resolveLiveEntitlements` for the **recipient org**.
Its `/org/me` identity equality stays intact; do not call it with a foreign source
org. Management of recipient acceptance needs a UOA-proven exact-team capability;
the current `LiveEntitlements` type exposes org role/team ids, so the team-capability
reader needs extending against a confirmed UOA contract. Missing proof denies.

All new bound-tenant checks must use this live boundary. Existing `TeamMember`,
`OrganizationMember` and UOA-derived anchor `ProjectMember` projections are not a
fallback. Resolve existing stable user references by UOA subject; never join by
email or name or add recipient memberships to satisfy a foreign key. A constraint
that requires source membership must be refactored to express product authorship
separately. Keep genuine source project membership and unbound local membership.

## 2. Schema and migration contract

Add **`ResourceShare`** (product authorization, not identity), with:

| Field group | Proposed data |
| --- | --- |
| Target | UUID id; `scope: project | board`; immutable `sourceOrganizationId`, `projectId`, optional `targetBoardId`; nullable live `boardId`; immutable source team stable reference validated from `Project.teamId` |
| Audience | Immutable recipient UOA organisation/team identifiers plus existing local product binding references where needed; no labels, profiles, members or mirrored hierarchy |
| Authority | Effective `access: read | write`; pending proposed access/version for upgrade; lifecycle state; monotone `revision`; nullable expiry |
| Actors | Stable creator, acceptor, revoker subject references with their acting org references; creation/acceptance/revocation timestamps |
| Health | Health state, stable reason code, `healthRevision`, transition timestamp; no raw provider messages or commercial state |

Enforce that project scope has neither board reference, while board scope always
keeps immutable `targetBoardId`. Pending and active board rows also require the
matching live `boardId`; a terminal row may lose that foreign key when its board
is deleted without losing its audit target. Composite foreign keys/constraints
prove project belongs to source org and a live board belongs to that project/org;
add the required composite uniqueness to the parent tables rather than relying
solely on route checks. Validate source and recipient orgs differ, source team
binding agrees, and recipient local binding agrees with the immutable UOA
references. Reject system/channel-root projects, system teams and unresolved
ownership. UOA hierarchy correctness is live proof, not a new durable projection.

Use separate partial unique indexes for active/pending project and board offers
to the same recipient team; nullable board uniqueness alone is insufficient.
Keep terminal rows for review, audit linkage and run dependencies. Add indexes for
recipient team/state/expiry, source project/state, board/state and revision-aware
run invalidation. No `ON DELETE SET NULL` may turn a board grant into a project
grant. Require explicit revoke before hard deletion, retain `targetBoardId` on
the terminal row, and clear only its separate live ancestry FK.

Add **board publication policy**, scoped to the board and separate from any one
recipient: `BoardSharedField` references allowed definitions/options, and
`BoardSharedResource` references explicitly published project page/folder roots.
These are authorization edges to existing content, not copied documents. Typed
relations/constraints reject foreign-project resources; all publication writes
prove source authority and validate retained provenance. A folder grants only its
current entitled descendants and never its ancestor/sibling contents. Initially
share one consistent board projection with every recipient rather than adding a
per-recipient field-permission language.

Publication policy has its own monotone revision, including allowed iteration
references. Carry it in access results and run dependencies. Removing a resource,
field or option, moving a page outside a published folder, and changing task/page
ancestry trigger the same stream/cache/notification/run invalidation as revocation.
Adding a resource or widening options is an audience publication, checked before
commit. Ancestor walks always use current structure; never preserve a removed link
through an old resolved descendant list.

Use the existing `KnowledgePage.taskId` structural link for task documents,
combined with publication policy and exact page/version access. Do not introduce a
second task-document mapping. A new board-bound document home, if needed for
board-wide documents, extends the existing knowledge home provisioner with a real
board relation; it must not be a fabricated Team or a guessed default space.

Add provenance completeness/version fields and normalized full-source/dependency
records at the current run/message/version write chokepoints (section 5). These
records store stable resource references and product authorization edges only.
Keep full consumed provenance distinct from the optimized display basis; do not
change the meaning of existing reduced basis rows silently. Suggested names are
**`RunConsumedResource`**, **`MessageConsumedResource`**, and a version counterpart
only where existing version basis storage cannot represent the qualified source.
Use one shared typed schema and persistence routine across these owners; implementation
should reuse existing normalized version source storage when it satisfies it.

An active run dependency names the selected share id/revision, effective human,
recipient team, source resource/version and admitted operation. The database owns
revocation state. Add no member snapshot or durable authorization token.

Migration is expand/backfill/validate, not a big-bang identity rewrite:

1. Add tables and constraints with sharing disabled. Existing rows receive no
   grants; existing outputs get `provenanceVersion = legacy_unknown`, never safe.
2. Run `scripts/inspect-team-shape.sql`; backfill `Project.teamId` only when the
   established audited inversion process proves a unique owner. Unresolved
   projects cannot share; never derive from a name, creation time or session.
3. Normalize task ownership around default-board changes and validate
   board/project/org, task/document and source-binding relationships. Report
   inconsistent rows, halt that project's activation and repair deliberately.
4. Keep existing UOA identity migration work separate but make every path touched
   here API-backed. Where existing duplicated profile/membership data is read,
   replace those consumers and migrate/remove the obsolete fields under the
   unification plan; do not add a compatibility copy to unblock sharing.
5. Audit and publish resource field/link policy explicitly. No grants, document
   exposure or provenance claims are inferred by a bulk backfill.

### Foundation schema now present

The additive, machine-only foundation consists of `ResourceShare`,
`BoardSharePublication`, `BoardSharedField`, `BoardSharedIteration` and
`BoardSharedResource`, plus strict shared record contracts. It does not activate
sharing or add an authorization path. `ResourceShare` retains local binding UUIDs
and their immutable UOA organisation/team references, with composite foreign keys
that prove source project/team and live board ancestry. Board shares keep an
immutable `targetBoardId` for terminal audit and a separate nullable `boardId`
relation; only the latter is cleared after revocation when a board is deleted.
Proposed and effective access each carry their own revision so an accepted read
grant can remain effective while a write widening awaits recipient acceptance.
The grant id, creation audit, target and audience are immutable. Decline,
revocation and expiry audit facts are append-only; an acceptance audit may change
only when a newly accepted widening advances the effective revision.

The database advances a board publication's revision for every field/option,
iteration or page-root insert, update and delete. Field option ids remain a closed
array because the current field definition stores options in JSON; the future
publication service must validate those ids before writing. A published page's
composite foreign key proves only its source project and organisation. It does not
make personal, team, organisation-wide or otherwise ineligible knowledge content
shareable; the resource authority and disclosure checks described below remain a
prerequisite.

The machine-only offer lifecycle now creates, accepts, declines, revokes and
expires grants through revision compare-and-swap transitions. Creation and
acceptance require an explicit rollout decision, injected current source/recipient
manager proofs and an injected sharing-policy decision. Acceptance locks and
revalidates the live source project, owning team, board and publication before the
grant becomes active. Each successful transition appends source and recipient
audit-chain entries inside the same transaction, taking organisation locks in a
stable order. Revocation remains available when rollout is disabled. No route or
surface calls this lifecycle yet, and exact-team management remains an upstream
UOA contract that callers must supply rather than infer from local roles.

Never edit an existing migration. Test baseline upgrade convergence; index large
message/run/audit tables following build-and-release guidance, not by blocking
unbounded rewrites in a request.

## 3. Services and API contracts

New **`resource-share-authority.ts`**, **`resource-shares.ts`** and
**`resource-share-records.ts`** in `packages/team-admin/src` respectively own access,
transactional lifecycle and safe DTO presentation. Keep cohesive modules under
the code size cap. Contracts live in new `packages/schemas/src/resource-shares.ts`
and the normal API contract/facade path, not duplicated handwritten DTOs.

Thin proposed route families:

| Contract | Gate / response |
| --- | --- |
| `GET/POST /api/projects/:projectId/shares` | Native source share-manager; list/create project offer |
| `GET/POST /api/projects/:projectId/boards/:boardId/shares` | Same native manager, exact board; board offer only |
| `GET /api/resource-shares/incoming?teamId=&cursor=&limit=` | Live entitled recipient teams; safe offer/active DTOs, explicit optional team filter |
| `GET /api/resource-shares/:shareId` | Source manager or exact entitled recipient; mode, scope, health, revision and allowed actions; pending detail requires recipient management |
| `POST /api/resource-shares/:shareId/accept`, `/decline`, `/leave` | Fresh UOA target-team manager authority; expected revision; atomic transition |
| `PATCH /api/resource-shares/:shareId` | Native source manager; access/expiry only; no target/audience edits; expected revision |
| `POST /api/resource-shares/:shareId/revoke`, `/resume` | Revoke: source manager; leave is recipient alternative. Resume: source manager or exact recipient-team manager after fixing their side, with both sides revalidated; cannot override source policy or revive a revoked grant |
| `GET /api/shared-resources` | Accepted resource summaries only, qualified source and recipient team, cursor-bound to actor/access context |
| `GET /api/shared-resources/:shareId/context` | Safe discriminated `project | board` projection, operations, visible sections and canonical target |
| Existing board/task/knowledge read/write routes with explicit optional share context | Resolve through same resource authority and domain service; no cloned task/knowledge business routes |
| Board sharing resource/field policy subroutes | Native source manager only; validate exact publication scope and audience before activation |

For existing resource routes, a declared `shareId` query/header identifies the
authorization path, not authority. Reject disagreement among path id, target,
source ancestry and share. Legacy calls without it retain native behavior. The
REST route obtains actor context; MCP/PA tools pass the same typed target into
the common service. Context-free old tools cannot mutate shared data. Context
selectors come from entitled discovery, never a string-matched user intent.

Validate body, path and query with strict schemas. Use 404 for inaccessible
objects, 403 for a known accessible resource with a denied operation, 409 for stale
revision/invalid transition, 410 only for a terminal share detail already
authorized to that viewer, and retryable 503 for upstream identity unavailability.
Do not distinguish guessed foreign ids from absent resources. Existing native
routes retain their documented denial codes where changing them is unnecessary.

Lists, counts, search, exports, aggregates, version history, thumbnails and realtime
must all consume the resource predicate before serializing. Counts describe only
the returned audience; paginate after authorization, not before it. Bind cursors
to actor/recipient org/team and query context and re-evaluate live entitlement on
every page. No cursor or cached `total` preserves withdrawn reach.

For tasks, introduce **`requireTaskAction`** and **`requireBoardAction`** over the
shared result; separate native project management from shared collaboration.
Constrain all related ids: columns, iterations, field options, parent tasks,
assignees, attachments and checklist templates. Shared assignees can be existing
source collaborators or live recipient members only where the source permits;
validate the target's actual resource reach and resolve display data through an
authorized UOA resource-participant projection. Do not expose an org roster or
insert `OrganizationMember` just to assign. Until that UOA display/target proof
exists, permit self-assignment/unassignment only. Prevent automatic foreign actor
assignment in `moveProjectTaskToColumn` from bypassing the same check.

For knowledge, extend the shared `SpaceViewer`/page authority boundary with an
explicit resource-grant arm. Do not set `baseEntitled` by pretending the recipient
passed source `/org/me`, and do not reuse personal `KnowledgePageShare` unchanged:
that model is same-org, personal-space, person-addressed sharing. Preserve ordinary
space restrictions, page/version lineage, comments, labels, spreadsheets and live
stream authorization. One authorized linked page does not unlock its home space.

Every mutation locks/rechecks grant revision and canonical ancestry in its domain
transaction before writing; use a consistent lock order across task moves, grant
revocation and board deletion. Expected resource revisions prevent lost updates.
On commit publish invalidation via the durable event/outbox mechanism. Refusal
before commit produces no data mutation, vendor call or charged execution.

Current source write-back occurs before the task transaction. Initial shared
writes must refuse that path before any vendor call. Later delegated external
effects need a per-grant dispatch fence/lease: dispatch and revocation serialize,
no new effect starts after revoke wins, in-flight effects are identified in audit
and reconciled. A post-call DB revision check cannot undo an external write.

## 4. Notifications, audit and health

Write lifecycle audit in the same transaction as the grant, including source
resource org, actual actor org/subject, recipient team, action, old/new modes,
revision and reason code. Do not serialize content, credentials or UOA profiles.
Existing `emitAuditEvent` derives tenant from the actor and is best effort; it
cannot be the sole durability mechanism for a cross-org grant. Extend the domain
audit path rather than forging `ActorContext`. Source security audit owns the
grant history; recipient acceptance/leave has a corresponding safe recipient-org
event correlated by share/revision. Never give recipients source `/api/audit-log`.

Use existing durable alerts/outbox and `(user_id, event_key)` uniqueness. Events:
`resource_share.offered/accepted/declined/access_changed/revoked/expired`, plus
`suspended/resumed`; event key includes share, revision, kind and recipient. Resolve
recipients through live UOA authority at transition/delivery without persisting a
roster. Safe recipient `UserAlert` rows live under the recipient bell organisation,
not the source tenant. Store stable references only; generic push says a shared
resource needs attention. Revalidate alert targets on read, click and delivery;
revocation notices expose no now-inaccessible title or preview.

Health changes use one conditional update with `healthRevision`, one durable
alert per transition, a stable reason and a remedy. Use the existing sweep locking
and queue idempotency conventions. UOA uncertainty is fail-closed and observable;
repeated verified loss of eligibility suspends. Background expiry is cleanup and
notification only: every access check independently rejects elapsed expiry.

Direct authorized human actions use ordinary share lifecycle confirmation.
An agent proposing creation/widening must request exact-action approval when
policy requires it, bound to resource, recipient, mode, revision and expiry, then
recheck authority before execution. Use `approval-card.ts` and existing PA copies
for approvers outside the originating thread. Do not create a second approval
inbox or make resource acceptance a fake task/run approval.

## 5. Disclosure is a launch prerequisite

Current `computeReplyBasis` subtracts the destination's source org/team/project,
channel and bound-agent scopes. Both `persistCurrentRunBasis` and `agent-message.ts`
persist this reduced basis. Therefore an empty historical message/run basis does
**not** prove project-only content. `versionDisclosureFromConsumedSources` retains
more complete document provenance, but owner ticket reads skip source stamps and
there is no completeness marker. Empty document lineage is not proof either.

Before external activation:

1. Make every read, including owner/admin reads, register its full qualified source
   in `ConsumedSourceSink`: transcript, task/detail/search, knowledge versions,
   attachments, memory, tool results, checkpoint resume and handoff briefs. Retain
   transitive full lineage atomically before any derived output/metadata commits.
2. Extend the typed vocabulary with exact resource scopes, at least task and
   knowledge version, and source organisation qualification. A board scope is
   useful for board metadata but insufficient for an answer based on a task that
   later leaves it. Record original source versions when facts are versioned.
3. Preserve full provenance alongside the optimized reply basis at every retained
   output: messages, run plans/thoughts, task output, document versions, summaries,
   search index results, checkpoints and delegated briefs. Mark completeness only
   on writes whose reader coverage is verified. Extend serializers and readers
   together; unknown vocabulary or unknown lineage fails closed externally.
4. Resolve destination implication from its **actual audience**. A project channel
   with external readers no longer implies source org/team knowledge or the whole
   agent's visibility. Keep those consumed scopes unless all readers independently
   have them; never satisfy them by handing recipients source org/team scopes.
5. For external viewers require current resource entitlement AND full provenance
   satisfaction, not merely the old reduced basis. A resource grant satisfies only
   its exact source resources. Private conversation source authors retain their
   exact-content export authority; a project manager cannot waive it.
6. Extend `persistVersionDisclosure` with a typed, server-validated cross-org
   resource source. Preserve existing same-org scope checks for existing types.
   Recipient-org documents derived from source content retain that source org and
   version; never relabel source provenance as recipient-owned or relax checks
   for arbitrary foreign ids. Version successor union rules remain in force.
7. Do not reuse `transfer/basis-check.ts`'s same-org assumption that an organisation
   scope is implied for a cross-org copy/export. Validate destination audience
   before any tool writes derived source data into a recipient resource.

Audience expansion must also fence already-running **source** agents: increment
the destination audience revision when a share activates or resource publication
widens, and re-evaluate it at output commit and live delivery. A source run that
started before the share has no recipient-share dependency, so dependency-based
revocation alone does not cover it. Stop an unsafe live lane before activation
becomes externally readable; keep full provenance from the run's original reads.

Historical model-derived content without provably complete lineage is withheld
from new external audiences while internal access remains unchanged. Backfill
only provable records; count and show excluded classes to source managers. No
empty-basis-to-safe migration. Re-generation from currently authorized sources is
the recommended remedy. Regeneration starts a clean output from independently
authorized original sources, not the unknown historical answer. Do not mark a
legacy version chain complete in place: successor union preserves its restriction,
so ordinary editing cannot remove legacy-unknown status. An exact-content publication workflow is a separately
approved product decision, and cannot override private-author consent rules.

Run-linked tasks currently require both run-channel reach and basis. A board grant
must not expose a private run merely to show its task. Initially withhold such
tasks unless those independent gates pass; separating a public task summary from
private execution output requires an explicit independently versioned publication,
not dropping the run gate. The UI reports that some source-only work is excluded
to source managers without leaking hidden counts to recipients.

## 6. Revocation and cached/run context

Promise: grant downgrade/revoke is authoritative at transaction commit; subsequent
requests/writes re-resolve it. Live delivery stops immediately on invalidation,
with a tested maximum five-second window aligned to current realtime entitlement
TTL. UOA removal takes effect on the next live request and within the same bounded
live-delivery window; if upstream guarantees cannot support that, do not advertise
the bound until the UOA contract and test prove it.

Persist run share dependencies at admission/read. On revoke, prevent new reads,
writes, child runs, checkpoint resumes, notifications and publication from that
authority; cancel/terminate affected in-flight execution or restart from a clean
currently authorized context. Checking only the next tool call is insufficient:
the model may answer from already-read context. Fence publication against the
current grant and full source basis. Never claim that deleting a prompt entry
causes a running model to forget it. An alternative independently valid grant may
authorize a clean re-admission, not silently mutate a suspended run's payer/audience.

Fan out a content-free access invalidation through durable multi-replica realtime.
Recheck WS/SSE at delivery and replay, not just subscription. A share's resource
lane is not a subscription to source org or source team events. Invalidation must
clear actor/team/share-revision query keys, cancel in-flight loads, and prevent
late responses refilling caches. Clear retained/seeded screens, previews, blob
object URLs, prewarm caches and share-scoped persisted drafts. Shared queries
deliberately do not use `keepPreviousData` across an authority change.

Existing attachment responses advertise one-year private immutable caching.
Shared-content downloads/thumbnails need `private, no-store` (including range,
HEAD and conditional paths), or an equivalently reauthorized short-lived transport;
an ETag/304 must not bypass the authorization check. Use FileService for bytes and
accounting; do not expose long-lived bearer object URLs or storage keys.

Revocation does not erase screenshots, downloaded bytes or information a human
already read. Retained source contributions stay in the source's audit/history;
the former recipient cannot read them without a new valid grant. Stop serving
cached/generated derivatives whose full source entitlement is lost, even when
their destination is a recipient-owned document or conversation.

## 7. Threat model and abuse cases

| Attack / failure | Boundary and required evidence |
| --- | --- |
| Recipient org admin acquires source admin | Separate actor/resource contexts and capabilities; matrix test every source management route |
| IDOR through task, column, field, iteration, file, source, cursor or bulk ids | Qualify ancestry and each referenced target; negative cases for all alternate transports |
| Source/recipient names collide; guessed team reference | Stable UOA ids, authenticated exact-team acceptance, rate limits and non-enumerating responses |
| Share-id tamper, replay, simultaneous acceptance/revoke | Immutable target/audience, revision CAS, unique live grant constraint, transactional audit |
| Filter manipulation or null/default-board retargeting | Ownership pool independent of filters; normalize default changes; revoke on board deletion |
| Source document linked to hidden sibling data | Explicit publication links and per-version basis, no ancestor/sibling listing; no implicit link-following |
| Recipient member removed, epoch rotated, identity service unavailable | Live UOA proof, fail closed, bounded caches, no local member fallback |
| Prompt injection in shared ticket/document tricks an agent into export | Effective-human tool caps, full source provenance, independent outbound/approval gates; model instructions are not authorization |
| Owner read omits basis; legacy answer leaks org secrets | Full source recording for all actors and legacy-unknown quarantine |
| Run consumed data before revoke, resumes elsewhere or streams text | Persist dependencies, fence resume/output, terminate dirty context; replay/stream tests |
| Shared RW spends source credits, changes vendor data or wakes privileged automation | Block these implicit effects initially; explicit source dispatch consent and payer fence before later enablement |
| Metadata leak via people, counts, alerts, activity, labels or thumbnails | Allowlists, current resource predicates, generic push and scoped cache eviction |
| Cross-org copy launders source content into recipient-owned durable output | Qualified immutable lineage and destination proof; no same-org transfer shortcut |
| Invite spam, upload exhaustion, costly live checks | Per-actor/org quotas/rate limits, existing FileService quotas, bounded request coalescing, no durable UOA cache |
| Revocation on API A but stale stream/job on B | Database revision, durable invalidation, delivery rechecks and two-instance race tests |

Raw ticket text remains user-authored content, not a command to change trust.
No keyword/regex intent classifier is added. Tests for agent proposals include
non-English, informal and misspelled inputs; structural policy gates stay deterministic.
