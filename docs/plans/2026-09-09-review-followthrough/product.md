# Product workflow plans

## 5. Open the ticket presented in chat

**Owner:** Terra. Home: existing task dialog in its project board. Doorways:
chat ticket card, cold task URL and subsequently Search.

1. Declare `task` in the project navigation intent. Reuse the framework for
   opening/closing detail and Back; do not create a second overlay mechanism.
2. Resolve the current task through the entitlement-gated detail endpoint and
   derive its actual board, including a default board, instead of trusting a
   stale board id carried by an old chat presentation.
3. Open the existing `TaskDialog` even if the card is outside the currently
   loaded column page or hidden by a board filter. Handle removed/denied tasks.
4. Preserve the original project/board context when detail closes.

**Acceptance:** headless chat-card click and cold URL open the exact task;
archived/off-page tasks work; denial shows a refusal; Back closes detail once.
Extend existing navigation/project-usability tests and navigation docs.

## 6. Tickets in human Search

**Owner:** Terra after 5. Home: Search results. Doorways: global search and
native/external ticket keys or titles.

1. Expose the existing `@nessie/team-admin` task search through a thin human
   route using the same access rules as the assistant tool.
2. Add schema-derived result types and facade pagination. Search all entitled
   projects unless the person explicitly selects a narrower filter.
3. Render a Tasks section in existing Search, reusing task presentation and
   item 5's navigation contract. Do not fork ticket lookup or authorization.

**Acceptance:** native titles and mirrored keys resolve across entitled
projects; private tasks remain absent; a result opens its exact task. Add API
authorization tests and a headless Search-to-task evaluation. Update search
and board-source product docs to match actual supported behavior.

## 7. Project administration permissions

**Owner:** Terra, sequential with 5/8 because `ProjectView` is shared.

1. Use `useCanAdministerProject(projectId)` for board creation and sprint
   create/start/complete/delete, matching the existing server gate.
2. Account for unresolved/failed permission queries without briefly displaying
   forbidden actions. Keep read access distinct from administration.
3. Reuse one decision for every project-shape control in the affected surface.

**Acceptance:** organization owners and project owners/admins see and can use
the controls; members/viewers do not. Test role changes without reloading and
server refusal after revocation. Extend the existing project browser fixture;
document the effective permissions beside the board/iteration contract.

## 8. Explicit project load failures

**Owner:** Terra. Home: existing project Board and Docs tabs.

1. Preserve the board-list query status instead of destructuring it to an
   empty array. Route loading, error and successful empty states distinctly.
2. Surface the actual space-list error and a refetch action in Project Docs.
   Reuse the knowledge surface's query/error primitives where applicable.
3. Show create/empty guidance only after a successful empty response; retain
   previously authorized data during an ordinary refresh where appropriate.

**Acceptance:** injected 500/network failures show an actionable error and
Retry; retry recovers; successful empty responses retain intended guidance.
Test project switches and prevent stale data from a prior project appearing.
Retain headless board/docs evidence and update knowledge/project UX docs.

## 9. Browser push tenant ownership

**Owner:** Terra. Home: notification settings; doorway: browser notification
toggle in the current organization.

1. Confirm the intended browser-level unsubscribe behavior versus removal of
   one organization's server registration; a browser endpoint is shared.
2. Make persisted uniqueness, registration, delivery and cleanup scope agree
   on `(organizationId, userId, endpoint)`. Add an immutable forward migration.
3. Reconcile browser subscription state with current-tenant registration so
   an existing browser subscription does not falsely imply tenant enrollment.
4. Preserve endpoint SSRF/IP pinning, cross-user isolation, send idempotency
   and the signed ordering protections of the separate native-device lane.

**Acceptance:** one user/browser can receive A and B notifications; removing
A's enrollment leaves B usable; switching accounts never transfers another
user's registration. Test upgrade, cap eviction, dead-endpoint cleanup and
headless settings behavior with a deterministic push-provider fixture.
Update `docs/web-push.md` and the public subscription contract.
