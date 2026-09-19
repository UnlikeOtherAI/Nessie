# Delivery, decisions and verification

Part of the [cross-organisation sharing plan](overview.md).

## 1. Phased sequence and gates

This is a dependency sequence, not permission to release a half-secured feature.
Every phase that enables a capability includes its owning UI and doorway. Dark
schema/service work is explicitly machine-only until its corresponding surface
ships. No share may activate before the relevant resource read, write, disclosure
and revocation gates exist across every transport.

### Phase 0 — settle contracts and audit eligible projects

Produce an endpoint/resource inventory and prove one source project has one team
with `scripts/inspect-team-shape.sql`. Read the current team inversion migration
and UOA unification plan; list which touched consumers still read durable UOA
copies, and replace those consumers through the live boundary as prerequisites.
Do not claim this feature completes the whole identity migration.

Confirm UOA recipient exact-team management, non-member source identity display,
resource participant display, and commercial eligibility contracts. Record product
choices from section 4 below. Verify cross-org storage attribution does not require
creating a source membership row. Inventory background task-change subscribers,
source write-back, exports, search, MIME previews and run output surfaces, not just
the REST board handler.

**Exit:** no guessed upstream API, all share-eligible content classes have an
authority owner, unresolved projects are named as blocked, and the product meaning
of whole-project sharing is agreed. This phase changes no runtime behavior.

### Phase 1 — ownership, capability and provenance foundations

Add grant/publication schema and full-source provenance schema under a default-off
rollout gate. Implement live recipient checks and the native/shared/denied
decision, preserving native authorization. Fix default-switch ownership so null
tasks cannot jump audiences; constrain moves and deletes transactionally. Add
native regression tests before routing shared requests through those functions.

Refactor the existing entitlement and disclosure services before reusing them for
foreign resources: no broadening `canModifyProject`, no source tenant impersonation.
Make owner reads register provenance, add completeness markers and full-source
persistence, and extend exact-version readers with qualified cross-org references.
Implement grant revision checks, durable invalidation and source/recipient audit
provenance. Schema and service foundations remain machine-only while disabled.

**Exit:** DB-backed tests prove no native behavior regression, no recipient role
escalation, no legacy empty-basis exposure and no null-board retargeting. Mixed old
and new readers are explicitly denied shared traffic during rollout.

### Phase 2 — usable read-only board sharing

Ship Board Sharing, resource preview/publication controls, recipient Incoming
Sharing and Projects discovery together. Include default-board explanation, source
identity, RO label, acceptance/decline/revoke/leave/expiry, safe unavailable states,
and exact alert deep links. Parameterize the existing board and task dialog.

Audit every board-only read: task detail/search, checklists, fields/options,
iterations, eligible task documents and versions, files/previews, activity, people
projection, source freshness, WS/SSE and MCP. Restrict all mutations server-side.
Ship actor/share-scoped cache invalidation and no-store shared blobs before pilot.
If a resource class cannot pass its gates, report it as unavailable in scope review;
do not silently call this a full deliverable while required documents are absent.

**Exit:** real source and recipient browser contexts use all doorways, see only
shared resources, and lose reads on revoke/removal; direct hostile HTTP/MCP calls
also fail. Source-approved board fields/documents are usable, not API-only.

### Phase 3 — usable read-write board collaboration

Enable ticket create/edit/status/archive/checklist, approved document edits/uploads,
scoped native column/layout changes and allowed assignment. Server pins the shared
board on creation, validates each related target and locks the selected grant
revision before mutation. Add optimistic conflict responses to prevent lost edits.

Keep mirrored provider mutations, source sync, source-agent assignment, new watchers
for other people, unattended agent wakes and integration execution denied. Audit all
task event consumers so an external mutation is not an implicit side-effect trigger.
Show those restrictions at the relevant controls with their reasons. Source's
ordinary synchronization can continue importing into a shared board as already
authorized; it does not acquire a new recipient credential or audience privilege.

**Exit:** source sees the same changed records, RO cannot write through any path,
board RW cannot escape its board, hidden fields are neither read nor overwritten,
and grant downgrade/revoke races cause no post-revocation commit or vendor call.

### Phase 4 — whole-project sharing and all eligible resources

Extend the same grant resolver/presenters to all project boards, backlog, scoped
insights, iteration/field administration, Project Docs and safe project dashboard
output. Project Settings Sharing reuses the board Sharing component. Gate project
overview prefetches and resource discovery by server capabilities, not ambient role.

Add eligible standard project channels with share-aware read/post participation
that never writes ChannelMember rows. Route generated content through the full
provenance policy and withhold private/unknown lineage. Explicitly deny project
membership, source org settings, secrets, connectors and executor management.
Whole-project acceptance names present/future content and every excluded class.

**Exit:** project RO/RW is complete for the agreed eligible resource table; every
project doorway is either authorized and functional or intentionally absent. Existing
private channel, private agent and document-version boundaries remain enforced.
Do not mark the overall feature complete after board-only delivery.

### Phase 5 — agent use, lifecycle robustness and general availability

Expose shared resource discovery/read/write in recipient PA and paired MCP paths
through the same functions as buttons, with effective-human proof, full provenance,
grant dependencies and correct recipient billing. Checkpoint, continuation,
handoff, search/memory, document live stream and message publication must enforce
revocation after material entered context. Agent share proposals use exact-action
approval cards when policy requires; they never grant access themselves.

Unattended source execution or upstream provider writes caused by recipient edits
remain out of initial scope unless separately approved and implemented with explicit
source consent, existing policy gates, payer admission and dispatch fencing. This
is an execution permission, not a third share mode. Source agent identities may
appear for attribution without exposing profiles or making them callable.

Run all required CI, requested Browser Suites, and dedicated multi-instance
revocation tests. Review threat cases and measured freshness. Remove the rollout
gate only when the minimum secure deployment is everywhere and both share scopes
and modes pass the acceptance matrix. Document the permanent execution restrictions.

## 2. Concrete implementation map

Paths below exist at the inspected revision except those explicitly labeled new.
Functions named here are entry points to audit, not a claim that changing one
function secures every caller.

| Area | Files / symbols | Work |
| --- | --- | --- |
| Data | `api/prisma/schema.prisma`; new immutable migrations; `scripts/inspect-team-shape.sql` | ResourceShare, publication links, qualified provenance/dependencies, constraints, audited ownership |
| Actor proof | `api/src/services/request-admission.ts::createRequestAdmission`; `packages/runtime/src/uoa-live-entitlements.ts::resolveLiveEntitlements`; `uoa-org-request.ts` | Keep actor org unchanged; exact recipient teams and team manager capability; remove touched local-authority assumptions |
| Project authority | `packages/team-admin/src/project-structure.ts::{isProjectAccessibleToUser,resolveProjectAccess,listAccessibleProjectIds}`; `resource-authority.ts`; `api/src/lib/{request-helpers,server-context}.ts` | New shared action boundary; native management unchanged; audit read predicate inconsistencies |
| New grant domain | New `packages/team-admin/src/resource-share-{authority,records}.ts`, `resource-shares.ts`; new `packages/schemas/src/resource-shares.ts`; new API route/service adapters | Lifecycle, qualified authority, DTOs, revision/CAS, audit and alert transition |
| Boards | `board-placement.ts::{boardTaskPoolWhere,resolveBoardPlacement}`; `board-structure.ts::{updateBoard,deleteBoard}`; `project-task-move.ts::moveProjectTaskToColumn` | Task ownership/default switch, allowed columns, before/after audience, source/target locks |
| Tasks | `packages/team-admin/src/{project-tasks,project-task-records,project-task-search}.ts`; `api/src/services/tasks.ts::listBoardTasksForUser`; task/checklist routes; `api/src/mcp/tools/boards.ts` | Scope all read/write/search/bulk/assignment paths; never expose unscoped `listBoardTasks` |
| Sources | `packages/team-admin/src/{board-source-writeback,board-source-credential,board-source-search}.ts`; `api/src/routes/board-sources/` | Refuse unapproved remote effects/search; sanitize state bindings, source config and health |
| Knowledge | `packages/knowledge/src/{access,version-disclosure,version-disclosure-where,version-disclosure-access,native-search-access}.ts`; `transfer/basis-check.ts` | Explicit resource-share arm and full qualified version lineage; no same-org shortcut |
| Knowledge routes | `api/src/routes/{knowledge-base-access,knowledge-tasks,knowledge-base-files,knowledge-comments}.ts`; spreadsheet and live-document route families | Page/task links, versions/comments/labels/export, exact share projection in every reader/writer |
| Bytes | `packages/runtime/src/files/index.ts`; attachment routes; `admin/src/lib/blob-cache.ts` | Exact reference authorization, source quota, no-store/range/304, scoped blob eviction |
| Worker reads/output | `worker/src/run/execute/{disclosure-basis,agent-message,checkpoint,run-recorders}.ts`; `worker/src/run/pa-tools/{ticket-context,ticket-search,tickets,knowledge-basis}.ts` | Full sink for owners, durable complete lineage, output/resume fence, grant dependencies |
| Shared disclosure | `packages/runtime/src/disclosure-{viewer,predicate,access}.ts`, `run-disclosure.ts` | Qualified resource scopes and actual audience checks without source membership |
| Realtime | `api/src/realtime/{delivery-entitlements,notification-delivery,hub}.ts`; `packages/team-admin/src/board-watch-notify.ts` | Per-event shared reach, replay, content-free invalidation, external-mutation wake gate |
| Audit/alerts | `api/src/services/{audit,alerts}.ts`; `api/src/contracts/alerts.ts`; `packages/db` `visibleUserAlertWhere`; `approval-card.ts` | Explicit source/actor tenant, transactional durability, recipient bell, live-safe links, approval cards |
| Billing | `api/src/services/{uoa-billing-client,billing-team,uoa-billing-capability,uoa-team-switch}.ts`; `confirmUoaDirectServiceAccess` | Confirm upstream contract; preserve exact funding actor; no local subscription state |
| Source UI | `admin/src/pages/project/{ProjectSettingsPage,BoardSettingsPage,ProjectBoardsPage}.tsx`; `ProjectPageHeader.tsx` | One new scoped Sharing component/dialog; project/board entry points and safe confirmation |
| Recipient UI | `admin/src/layouts/admin-shell/{ProjectsSidebarNav,ProjectRow,ProjectSectionRows}.tsx`; team settings; `ProjectView.tsx` | Incoming/discovery, shared route adapter, exact-scope fetches, no default-board fallback |
| Board reuse | `ProjectBoardTab.tsx`, `useBoardChrome.ts`, `KanbanBoard.tsx`, `TaskDialog.tsx`, `TaskDocuments.tsx`, `TaskChecklistTab.tsx` | Explicit capabilities, scoped people/fields, read-only mutation controls, narrow Docs entry |
| Frontend authority | `admin/src/facades/projects/{administration,hooks,keys}.ts`; `navigation/project-sections.ts` | Replace shared reliance on `useCanModifyProject`'s active-org admin shortcut; no forbidden prefetch |
| Navigation/cache | `admin/src/navigation/{surfaces,surface-lookup,prewarm,intent,useTabParam,useDraft}.ts`; `providers/AuthSessionProvider.tsx`; facade keys | Registered parents/params, cold links/Back, authority-keyed caches and draft invalidation |
| Alerts UI | `admin/src/components/shared/AlertRow.tsx`; `facades/alerts/hooks.ts::getAlertLink`; bell/page components | Exact share doorway, safe revoked state, no foreign title in generic push |

Refactor before reusing a currently single-use path, keeping domain ownership and
the frontend import layering. Do not create a catch-all cross-tenant utility,
duplicate task route family, or second knowledge browser. New shared contract
fields must be accepted by all relevant strict schemas before enabling them.

## 3. Verification and acceptance evidence

### Authorization matrix

Use fixtures with organisations A/B/C, source teams A1/A2, recipient teams B1/B2,
two projects, default/non-default boards, public/protected channels, private agents
and independent documents. Include the same human legitimately belonging to more
than one org/team and different people with identical display names.

Cross product the relevant cases rather than relying on one happy path:

| Dimension | Required cases |
| --- | --- |
| Actor | Source project member, source org owner/admin, source team-only manager, source public reader, recipient B1 member/manager, B2 member, recipient org admin outside B1, removed/deactivated/epoch-revoked actor, anonymous, PA, paired agent |
| Grant | Project/board × RO/RW; pending/accepted/declined/expired/revoked/suspended; stale revision; overlapping project and board grants |
| Operation | List/detail/search/count/export; all task/column/field/iteration/document/comment mutations; run/agent/source/secret/admin denies |
| Resource relation | Exact board, sibling board, other project, other source team/org, null default task, moved/deleted task, linked hidden resource, archived content |
| Channel | HTTP, alternate generic route, MCP, PA, queue/resume, WS/SSE replay, alert/push, thumbnail/range/conditional download |
| Provenance | Human content, verified generated content, source-org knowledge, private-source lineage, foreign version, legacy unknown, moved source, revoked independent source |

Native-source tests continue proving equal project member management, public read
versus modify distinction, and protected/DM/agent exceptions. Shared RW tests
explicitly deny grant administration and source identity/billing/connector access.

### Unit and database-backed integration

- Pure predicate tests: exact team match, complete authority alternatives, RO/RW
  operations, qualified ancestry, projection allowlists, expiry/revision, live
  failure, audience implication, source lineage and reason-code rendering.
- Real Postgres constraints: invalid cross-org board/project tuples, nullable
  scope uniqueness, concurrent offers, accept-versus-revoke, two managers updating,
  delete/default-switch/move-versus-read, rollback leaving no auditless grant.
- Resource isolation: sibling titles/ids/counts/options, users/agent profiles,
  task hierarchy, state bindings, hidden field overwrite, copied board settings,
  source remote search, archived/deleted objects and all file representations.
- Writes: RO mutation via every route/tool; shared board create with omitted or
  forged `boardId`; movement before any vendor effect; recipient autoassignment;
  all bulk items validated atomically; source storage quota and attribution.
- Revocation: stale JWT/UOA projection, denied `/org/me`, expired grant without
  sweep, pagination after revoke, pending queue delivery, retry/resume/replay,
  old preview/download URL and invalidation on another API instance.
- Disclosure: source owner reads are stamped; incomplete legacy content stays
  withheld; source-org and private data cannot be published to a new external
  audience; recipient document derivative preserves source provenance; revoke
  after model consumption but before reply prevents output. Test full-context
  child runs, checkpoints, thoughts, task summaries and live document output.
  Activate a share/publish a board resource while a source agent is already
  running, and prove the widened destination is rechecked before output even
  without an existing share dependency. Remove publication links/options and
  move pages out of published folders to prove policy-revision invalidation.
- Event/health: one alert per revision, recipient bell org, no names/previews after
  loss of reach, explicit resume rechecks both teams without changing billing,
  transient outage does not permanently rewrite grant authority.

Extend existing homes such as `api/test/project-equal-rights-routes.test.ts`,
`project-membership-isolation.test.ts`, `board-task-disclosure.test.ts`,
`disclosure-read-paths.test.ts`, `disclosure-grant-realtime.test.ts`,
`mcp-board-writes.test.ts`; `packages/runtime/test/uoa-live-entitlements.test.ts`;
and team-admin `project-structure-db`, `project-delete-db`, `board-placement` and
`board-source-writeback` suites. New tests must live in their package's test glob;
extend every Prisma fake whose query shape changes. A fake that ignores `where`
does not prove tenant isolation.

Run package tests through `pnpm exec turbo run test --filter=<affected-package>`
with `DATABASE_URL` exported for that run, then required CI. Assert no intended
Postgres suites were skipped. Preserve worker-before-api ordering and concurrency
limits. Seed unique fixture ids; clean only those ids; assert fixture outcomes,
never global counts. Queue/poller and two-instance scenarios use a dedicated,
migrated database outside every worktree and verify it is quiet before starting.

### Headless Playwright journeys

Extend `admin/e2e/project-usability/{ci,run,board-management,project-administration-permissions,project-load-failures}.mjs`
with a cross-org fixture and independent authenticated source/recipient browser
contexts against the real API/database. A mocked UI roster alone proves no server
authorization. Reuse scripted UOA protocol responses at the authority boundary,
and scripted mock-LLM inference for enforcement; neither claims live-model
language understanding or an upstream production contract test.

1. Source offers project RO; recipient manager accepts from Incoming/bell, then
   ordinary member opens it from Projects. Show source org/team and correct mode.
2. Repeat board-only RO; prove no project overview/member/sibling queries occur,
   even via prewarm, navigation seeds or direct id URLs. Verify scoped Docs.
3. Upgrade to RW with acceptance, edit/create task/checklist/document and drag
   within the allowed board; source sees the same rows. Direct forbidden HTTP and
   MCP mutations remain denied. Verify field/iteration/assignment constraints.
4. Source downgrades/revokes while recipient has an open dialog, document, blob
   preview, unsaved draft, retained route and stream. Controls/content clear,
   requests in flight cannot refill state, stale autosave fails, Back stays safe.
5. Remove recipient in UOA and rotate epoch; stale session, alert, copied link,
   search cursor and websocket cannot retain access. Confirm another independent
   grant preserves only its own scope.
6. Move a task out; old task link does not reveal its new board. Change default
   board with null tasks, then delete the shared board; no grant retargets.
7. Source agent reads private/org data and attempts to answer in an externally
   shared room/document. Verify withholding and run metadata protection; revoke
   after consumption and before commit/resume. Include non-English proposal text.
8. Simulate eligibility suspension and UOA outage. Exact repair doorway works;
   login does not heal a suspended grant and no source billing manager UI leaks.
9. Check phone/tablet/desktop, keyboard, focus restore, Escape/Back, cold links,
   reload, reduced motion, delayed/refused fetch and same-named organisations.
   Screenshot each affected surface and verify it visually.

Use this worktree's fixed resolved ports, hot reload via `pnpm dev`, and verify
API `/health` plus admin `/` with `@vite/client` after every start. Do not adopt
another worktree's server. Rebuild the worker after worker changes. Request
`gh workflow run browser-suites.yml --ref <implementation-branch>` because Browser
Suites is not a required PR status and otherwise will not run. Retain traces,
screenshots, authorization matrix results and the exact tested SHA with the PR.

### Test reporting for this planning change

This change creates documentation only. No runtime behavior, UI, schema or test
fixture is modified. Its appropriate local checks are document links, Markdown
structure and whitespace; required branch CI still governs the documentation PR.
Implementation tests and Playwright described above have not been executed by this
planning change and are not claimed as passing evidence.

## 4. Open decisions and blockers

| Decision / blocker | Recommendation | Required resolution |
| --- | --- | --- |
| Who may export externally? | Native source project modifiers, preserving equal rights; source policy may narrow | Confirm default policy and update team-model exception explicitly |
| Recipient acceptance | Exact-team UOA manager accepts; ordinary membership consumes | Verify authoritative team-management API, not just org role |
| Discovery of foreign teams/labels | Exact stable reference plus recipient acceptance; no global directory | UOA-permitted source identity and participant display contract; do not use domain API as universal roster |
| Subscription rules | Both use their own UOA access; no subscription transfer | UOA defines share eligibility/free receiving and authoritative suspension contract |
| Entire project content | All present/future share-eligible content; private/operational resources excluded | Product agrees scope table and disclosure exclusions before labelling it whole-project sharing |
| Board visibility filters | Share the owned pool, not current visual filter | Confirm source-facing wording and default-board future-write implication |
| RW breadth | Collaborate on work and native board layout; source retains lifecycle/audience/credential administration | Confirm archive, column edits, field/iteration management and storage consequence |
| Standalone ticket comments | Do not use private run conversations as comments | If product requires new task comments, design one task-owned model/surface in the existing TaskDialog; current schema does not establish it. Document comments remain supported |
| External assignees | Self-assignment first; other resource participants only with live target proof and safe identity projection | Do not fabricate source-org members; validate global user FK semantics |
| Board documents | Existing task links plus explicit board publication, reused Knowledge viewer | Decide whether board-wide document creation requires a board-bound home in first release |
| Legacy agent answers/documents | Withhold incomplete lineage externally; regenerate with verified sources | No safe generic backfill exists for provenance already subtracted |
| Source agents/provider writes | Separate explicit authority and billing; block implicit effects initially | If demanded at launch, expand execution phase and tests before release, never infer from RW |
| Revocation promise | Next request/commit; maximum five-second live stream window, immediate invalidation when possible | Measure across replicas and obtain UOA freshness guarantee; downloads already obtained cannot be recalled |
| Default-board changes | Preserve existing null tasks on old default transactionally | Confirm behavior change, migrate/test before enabling default-board sharing |
| Different installations | Same installation only | Federation is a separate scope, not a compatibility fallback |

Current architectural conflicts that must be resolved, not hidden:

- Durable UOA profiles/membership projections remain in the repo. The requested
  invariant forbids extending them; touched authority consumers need API-backed
  refactoring and an audited data migration, not new recipient rows.
- `Project.teamId` remains nullable. Sharing cannot infer one team from legacy
  `Team.projectId` where multiple or inconsistent candidates exist.
- Project public read and helper-based board/task reads are not uniformly aligned:
  `isProjectAccessibleToActor` still uses the native membership/admin predicate.
  The new action model needs explicit native regressions rather than a blanket
  replacement that accidentally widens writes.
- `useCanModifyProject` trusts the active org admin role for rendering; it is not
  usable for a foreign resource. `ProjectView`, assignee/field fetches, sections
  and unavailable-board fallback all assume broad project reach.
- Existing source-only channel/org realtime lanes, one-year blob caching, retained
  screens and `keepPreviousData` conflict with external revocation unless changed.
- Historical board plan/schema comments still call boards views; current code and
  as-built own tickets. Approval spec historical UI sections mention an inbox;
  its core rules forbid one. Follow current rules and correct stale text in the
  affected implementation docs, not by copying it into new surfaces.
- Existing run/message basis drops full source provenance; version checks reject
  foreign scopes and assume some same-org implications. These are hard data
  boundary blockers, not UI bugs to work around.

## 5. Rollout, observability and rollback

Use one temporary server deployment gate `crossOrganizationSharing` (proposed),
default off, with a small explicit source/recipient team-pair pilot allowlist.
It is justified by changes to authentication, mixed-version readers and irreversible
disclosure. It is not a locally mirrored subscription flag or a new settings
cascade. All transports ask it server-side; the UI receives its capability result.
Disable activation on old worker/API versions. Roll out schema/readers everywhere
before enabling any writes or accepted shares; each phase has its own deployment,
not an open-ended family of unrelated feature flags.

Observe content-free counters and traces: access denies by action/reason,
UOA latency/unavailability, grant transition conflicts, resource ancestry failures,
withheld legacy/current provenance, stale-revision writes, revoked run termination,
post-revoke delivery latency, suppressed external-trigger effects and alert
delivery failures. Avoid subject/team/resource ids as unbounded metric labels;
use scoped audit/correlation ids for investigations. Monitor performance of scoped
search and live membership checks; bounded request coalescing is allowed, stale
authority after expiry is not. No new member-facing operational dashboard.

Rollback first disables new offers/activation and shared data access, fences
shared-origin jobs, invalidates caches/streams and leaves native source work intact.
Keep source/recipient revoke/leave management reachable. Do not drop grants, source
contributions, audit records or provenance. Resume requires an explicit manager
action after compatibility/authority is restored. Do not roll binaries back to a
version that reads new qualified provenance as unrestricted; use a forward fix or
a compatible read-deny release. Database rollback is not deletion of added columns
or reversal of already-observed disclosure.

All implementation branches follow mandatory worktree, immediate commit push,
green PR and merge workflow; request browser suites for relevant UI changes.
Keep databases and durable test artifacts outside worktrees. Nothing here authorizes
implementing the feature as part of this documentation-only task.

## 6. Documentation updates during implementation

- Add a routed `docs/standards/resource-sharing.md` once behavior ships; concise
  signposts in AGENTS/CLAUDE, not an inline restatement of the feature.
- Update `team-model.md` with resource grants versus native membership, exact
  source/recipient authority, UOA live proof and owned-project requirement; update
  the UOA unification plan as touched projection debt is removed.
- Correct board overview/as-built and schema comments; document task ownership,
  default changes, field/iteration publication, moved resources and external
  source write-back restrictions.
- Update disclosure and knowledge/version/transfer standards for full source
  completeness, foreign resource provenance, legacy behavior and revocation;
  update PA/paired tools and run lifecycle contracts where their surfaces change.
- Update customer billing only after the authoritative UOA contract is settled;
  document storage/inference attribution without local pricing or eligibility state.
- Update navigation registry and chapters, frontend cache/draft/blob exceptions,
  capability health, user alerts and file caching. Update design-system usage only
  if a shared primitive contract changes; do not duplicate component rules.
- Add `docs/testing/cross-organisation-sharing.md` with fixture ownership, matrix,
  commands, expected deny cases, screenshots and multi-instance revocation bounds.
- Update the relevant active product scope/spec and `docs/known-limitations.md`
  as each phase ships. Keep this proposal marked proposed/partial until both
  scopes and both modes meet their acceptance criteria, then record as-built
  deltas and move completed planning material to `docs/done/` under repo policy.
