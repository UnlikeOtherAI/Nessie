# Adversarial review — docs/plans/2026-08-31-first-login-workspace-provisioning.md

Scope: verify every mechanism claim at its cited file:line in this Nessie
worktree and in UOA at `/Volumes/External/Projects/UnlikeOtherAuthenticator`
(main checkout; the plan says "verified 2026-08-31 in the UOA repo" — I used
the main checkout, not the `.worktrees/*` siblings, unless noted). Then hunt
invariants, races, rollout traps, security regressions, missed consumers, and
simpler alternatives. Section D reviewed only for unanticipated consequences.

---

## Citation audit (mis-citations and misreadings)

### 1. [major] `team.service.teams.ts:153-190` is cited for "the latter creates an orphan team" — but that exact range is the *authorisation* code, and the defect description undersells the real defect class.

UOA `API/src/services/team.service.teams.ts:140-160` shows `createTeam` calling
`resolveAndAuthorizeTeamOrg({ orgId, actorUserId })`, which at
`services/team.service.base.ts` (the `resolveAndAuthorizeTeamOrg` body)
**returns early with no membership check when `actorUserId` is undefined**
(`if (!params.actorUserId) return org;`), and then calls
`requireWorkspaceCapability(..., 'teams.manage', { actorUserId, ... })`. The
no-membership / no-capability-grant hole in backend mode is the *real* known
defect and the plan's A2 fix ("gains a `creatorMembership` option") fixes only
the missing membership row, not the missing authorisation. In backend mode
today, `POST /org/organisations/:orgId/teams` mints a team in **any org whose
origin domain matches the bearer** with no membership check and (pending
verification of `requireWorkspaceCapability`'s undefined-actor branch)
possibly no capability grant — the caller is the domain backend, full stop.
Remedy: A2 must be rewritten as "add an explicit acting-member parameter that
is REQUIRED on every person-acting call, and make `resolveAndAuthorizeTeamOrg`
+ `requireWorkspaceCapability` refuse when it is absent on
person-intent routes", not just "add `creatorMembership`".

### 2. [minor] `routes/org/me.ts:106,124-126` cited for the zero-workspace shape — line numbers drifted, claim itself is accurate.

UOA `API/src/routes/org/me.ts` builds `const response: { ok: true; org?: typeof
org } = { ok: true }` and sets `if (org) response.org = org;` at ~lines 122-126
(not 106/124 exactly). The semantic claim — `workspaces`/`pending_invites` are
nested *inside* `org` (`return { ...context, workspaces, pending_invites }`),
so a zero-workspace user gets neither `org` nor the onboarding fields — is
verified. Remedy: re-pin line numbers; no design change needed.

### 3. [minor] `WorkspaceChooserPage.tsx:170,244` cited for the "new organisation" branch — accurate but the cited lines contradict A3's framing.

`Auth/src/pages/WorkspaceChooserPage.tsx:167-175` shows
`canCreateFirstWorkspace = workspaceChoices.can_create_org && !hasTeams &&
!hasInvites` — the "new organisation" branch is *already* hard-wired to "has
nothing yet" AND "no pending invites", and `creatableOrgs` is already
server-decided (`allow_user_create_team` + ACTIVE owner/admin). The plan's A3
bullet says these "become policy-driven instead of hard-wired" as if new work;
the chooser half is mostly already done, and the part that is hard-wired
(`!hasTeams`) is a one-line client gate, not a service-layer rule. Remedy:
recast A3's chooser bullet as "relax the `!hasTeams` conjunct in
`canCreateFirstWorkspace`", and note `can_create_org`'s server computation in
`buildWorkspaceChoices` (not the cited file) is where the real gating lives.

### 4. [blocker] The plan never verifies the load-bearing A1 claim: that `placeUserInConfiguredOrganisation` is race-safe for concurrent first logins.

The plan's Invariant 3 asserts idempotent provisioning "under the same
advisory-lock discipline `resolveUoaWorkspaceContext` already uses". But UOA
`API/src/services/org-placement.service.ts` `autoCreatePersonalOrgForUser`
(lines ~109-196) does: **no advisory lock at all** — just
`orgMember.findFirst({ userId, org: { domain } })` then create org → team →
orgMember → teamMember inside one transaction, with the whole thing wrapped in
a `catch` that converts *any* error to `{ status: 'skipped', reason:
'auto_create_failed' }`. Two concurrent first logins (two devices, or OAuth
callback + refresh retry) both pass the `findFirst` gate; today the unique
partial index `org_members_one_active_org_per_domain` (migration
20260730180000) makes the loser's transaction fail at `orgMember.create` — the
loser then gets `auto_create_failed`, i.e. **no org at all** on that login,
not convergence on one org. Worse: A3 proposes *dropping* that index for
N>1 domains, removing the only race guard, in exchange for a "service-layer
check plus a domain-scoped constraint trigger" that the plan itself defers as
"an implementation decision for review". That is the single most
safety-critical mechanism in Part A and it is unspecified. Remedy: before A1
ships, give `autoCreatePersonalOrgForUser` the per-user advisory lock that
`ensureUserHasRequiredTeam` already uses
(`user-team-requirement.service.ts:41-47`, `pg_advisory_xact_lock(
uoa:required-team-placement:${userId})`), and make A3's enforcement mechanism
a *decided* precondition, not an open question — the open question the plan
lists ("service check + constraint trigger vs redesigned partial index") is
precisely the thing that must not be open.

### 5. [major] `org-role-guard.ts:252-257` cited for "access-token calls are pinned to the token's own org, so cross-org creation needs re-scoping" — correct, and it makes B2's "existing organisations" picker partially broken as designed.

Verified at `middleware/org-role-guard.ts:245-258`: `if (orgId &&
normalizeOrgId(memberOrgId) !== orgId) throw INSUFFICIENT_ORG_ROLE`, and the
token's `claims.org.org_id` is a **single** org (the active one). Under A3's
relaxed multi-org policy, a user who belongs to orgs X and Y holds an access
token carrying exactly one `org_id`; creating a team in the *other* org is
structurally refused in user mode, and backend mode skips the membership check
entirely (finding 1). So B2's organisation picker can only ever offer (a) the
active org in user mode, or (b) any origin-domain org with no per-member check
in backend mode. The plan's "authorisation mirrors UOA's own rules" sentence
(B2) cannot be satisfied by either mode as they exist today; it requires the
A2/A6 work the plan mentions but does not sequence before B2. Remedy: sequence
the `org-role-guard` / backend-actor redesign *as a blocking dependency of
B2*, and say so in "Sequencing" (currently step 3 says only "behind the UOA
deploy of A1/A3/A4" — A2 is in step 2 but its role-guard half is not called
out as B2-blocking).

### 6. [minor] `POST /org/organisations` (backend mode) is described as "user + backend modes" — accurate, and it already takes an explicit `owner_user_id` body field in backend mode.

Verified `routes/org/organisations.ts:110-132`: backend mode REQUIRES
`owner_user_id` (`OWNER_REQUIRED` if absent), user mode FORBIDS it
(`OWNER_NOT_ALLOWED`). So the create-org relay in B2 can name the acting user
as owner — good. But note the org creation path applies a **per-domain hourly
ceiling** (`routes/org/organisations.ts:33-40`, ~5/hour keyed to the domain in
backend mode, deliberately collapsing the key to the shared bucket "the
tenant's own trusted backend"). Five concurrent new-user first logins per hour
across the whole Nessie domain would trip the ceiling if A1's auto-create ever
routes through this endpoint (it doesn't today — auto-create uses
`org-placement.service` directly — but B2's "new organisation…" relay would).
Remedy: state the rate-limit budget explicitly in B2 and decide the
user-facing behaviour when the domain bucket is exhausted.

### 7. [minor] `api/src/services/uoa-session.ts:193-203` and `auth-login.ts:143-153` — verified as cited.

The "incomplete session proof" throw is at `uoa-session.ts` ~193-204
(`claims.domain !== settings.domain || ... || !selectedWorkspace.teamId`),
and `auth-login.ts:146-153` repeats the org+team check. No issue.

### 8. [minor] `workspace-context.ts:286-325` / `327-388` split — verified.

The UOA 1:1 branch (`workspace-context.ts:284-321`, advisory locks
`lockExternalOrganization` then `lockExternalWorkspace`, then
`materializeWorkspaceTargetInTransaction` at `workspace-target.ts:112-162`)
matches the plan. The shared-org fallback below it is guarded by
`workspaceId && selection.organizationId`, so it is indeed unreachable from a
UOA login (every UOA token carries a workspace claim). One correction to the
plan's phrasing: `resolveUoaWorkspaceContext`'s transaction does NOT call
`ensureWorkspacePrincipal` under the same advisory locks — `ensureWorkspacePrincipal`
is a *separate* `$transaction` (`workspace-principal.ts:249-294`) that
re-acquires `lockExternalOrganization` itself. Two concurrent logins of the
same user can therefore interleave between the two transactions; convergence
is saved only because the second transaction re-locks org → sub → email in a
fixed order. This is fine, but the plan's "one reusable, race-safe
implementation" elides a two-transaction seam that matters for finding 4's UOA
analog. Remedy: document the two-transaction structure when describing the
materialization reuse in B3.

### 9. [minor] `workspace-invitations.ts:32-128` relay precedent — verified, and it exposes a gap in B2's auth story.

The invitation-accept relay (`api/src/routes/workspace-invitations.ts:32-60`)
verifies a Nessie *session token* with `claims.providerType === 'uoa'`, loads
the user's `uoaSub` from the local row, and relays backend-mode with the
domain hash. B2's new `POST /api/workspace/teams` is described as "domain-hash
bearer + acting user's UOA subject". But UOA's `POST
/org/organisations/:orgId/teams` **has no acting-user field in backend mode**
(`orgCaller` in `organisation-route.shared.ts` returns `{ actor: { via:
'domain_backend' } }` when no token header is present; there is no `user_id`
body param on team create). So "acting user's UOA subject" in the plan's relay
description is currently unimplementable — the bearer identifies the *domain*,
not the user. Combined with finding 1, the relay's actual authorisation today
is: any Nessie-authenticated user with a UOA session can mint a team in any
Nessie-origin org. Remedy: the plan must state explicitly that B2 is blocked
on a UOA-side change (new `actor_user_id`-equivalent on the backend team-create
contract, or a user-mode token relay), and add Nessie's own membership check
("actor is an ACTIVE member/owner of the target org, proven by the UOA roster
relay") as the gate in the meantime.

### 10. [minor] `integrations.ts:38-49` and `uoa-recovery-link.ts:115-120,141-148` — verified as cited.

`uoaLinkMetadata` writes `teamIds`/`teamRoles`/`orgRole` into
`ProductAccountLink.metadata`; the recovery path rewrites `workspaceDirectory`
into metadata. B5's claim "Nothing reads them" I could not refute — grep shows
no consumer of `metadata.teamIds`/`teamRoles`/`orgRole` outside the writers.
Survives.

---

## Invariant / race / rollout findings

### 11. [blocker] A3 + Nessie's `switchUoaWorkspace` reauthorization: multi-org users get a broken switch path the plan does not mention.

Nessie's workspace switch is a **session reauthorization through UOA**
(`api/src/routes/auth-uoa-workspace.ts:48+` → `materializeUoaWorkspaceSwitch`
→ exact-target pinning in `uoa-workspace-switch.ts`), and the UOA access token
carries a single `active { orgId, teamId }`. Under A3's N>1 policy, UOA's
token-refresh/`select-team` machinery decides which org is "active" — and
`resolveExternalWorkspaceSelection` (`identity-display.ts:45-51`) falls back to
`teamIds.length === 1 ? teamIds[0] : null` when no `activeTeamId` is present.
The plan never says how UOA's session-choices/refresh layer represents a user
with N active orgs on one domain; if any UOA code path assumes "one org per
domain ⇒ workspace selection is unambiguous", N>1 silently changes its
meaning. This needs a UOA-side audit item; it is currently absent from the
plan entirely. Remedy: add an explicit A3 work item — "audit every
`teamIds.length === 1` / active-org-assumption consumer in UOA and Nessie
before the policy knob ships".

### 12. [major] B2's "switch into the new team" step races UOA's directory propagation.

B2 says: relay create → "immediately performs the existing UOA workspace
switch into the new team". The switch (`POST /api/auth/uoa/workspace`)
re-verifies against UOA and requires UOA to return the exact target
(`uoa-workspace-switch.ts:176-193` throws `WORKSPACE_NOT_AVAILABLE` /
mismatch errors if the refreshed session doesn't land on the requested
workspace). If the create transaction has committed but UOA's
`/auth/session-choices`/refresh pipeline hasn't yet re-read the membership
(the chooser reads run under `lockProductWorkspacePolicyShared` + epoch locks
— `auth-session-choices.ts:60-80`), the immediate switch can fail spuriously,
leaving the user with a created-but-unreachable workspace until they retry.
The plan treats create+switch as atomic; they are two separate UOA
round-trips. Remedy: specify retry/poll semantics for the post-create switch
(the invite-acceptance flow presumably has the same gap today — check whether
`facades/workspace/invitations.ts:31` retries), or have UOA's create response
itself mint the switched session the way `/auth/create-workspace` finalises
login inline (which is exactly the "reuse the login-bridge flow" option the
plan lists as an open question — this finding argues for that option).

### 13. [major] Rollout trap the plan half-catches: B1's `UOA_NO_WORKSPACE` classification must ship BEFORE A1, not "behind" it.

Sequencing step 3 puts "Part B behind the UOA deploy of A1/A3/A4". But B1's
named-refusal work is the *failure handling* for exactly the window between
"UOA deployed with the feature flag off / partially rolled out" and "feature
flag on". If B1 ships after A1's flag flips, any user hitting the
flag-off/failed path (`auto_create_failed` — see finding 4, where the race
loser gets exactly this) sees raw `EXTERNAL_AUTH_FAILED` with no remedy copy.
Also unaddressed: what happens to users created in the window between the
production cleanup (Part D, already run) and the A1 deploy — they get refused
at login today, and there is no backfill story (A1 is first-login-triggered;
a user whose first login already failed has... not failed permanently, since
placement re-runs per login — verify this; `placeUserInConfiguredOrganisation`
runs in `social-login.service.ts` / `auth-verify-email.service.ts` per
authentication, so retry works, but say so). Remedy: reorder — B1's
classification ships with or before A1's flag flip, and state that first-login
placement is self-healing on retry (or add the explicit re-entry point).

### 14. [major] A4's `/org/me` change is NOT additive-safe for Nessie as deployed today.

A4 claims "existing consumers that check for `org` presence keep working
because the block is only added, never reshaped". But the current Nessie login
path does not consume `/org/me`'s shape leniently — it hard-refuses a token
without org+team (finding 7). More importantly, A4 changes the meaning of
"`org` present with empty `workspaces[]`": today `org` present ⇒ context
resolved. Any UOA-internal consumer that treats `response.org` as proof of
placement (e.g. chooser routing, other products) would now see
`org: { workspaces: [] }` and must distinguish. The plan asserts the
compatibility direction without auditing UOA's own consumers of `/org/me`.
Remedy: grep UOA (Admin, Auth, API) for `/org/me` consumers and list them as
A4's compatibility checklist; flag-on parity (old shape when the domain hasn't
opted in) is the cheap safety.

### 15. [minor] Part D consequence the plan does not anticipate: the "green field" makes the F7/heal path load-bearing on day one, and the UOA org-name placeholder sync is the only name source.

Post-cleanup, every org/team is materialized fresh. The plan's B5 proposes
healing `Team.name` from UOA workspace labels "the way
`syncExternalOrganizationNames` heals org names" — but that heal runs off the
workspace *directory* fetched at login/rotation
(`integrations.ts:154-170` + `uoa-refresh-coordinator.ts`). Until B5 lands,
every freshly materialized Team keeps the placeholder name (see
`external-organization.ts`'s `Organisation ${externalOrgId.slice(0,8)}`
pattern for orgs). With the green field, 100% of visible names depend on the
directory sync being primed — a cold API process after restart serves degraded
derivations (`uoa-directory-cache.ts` is per-process, TTL 30 min). Not a
blocker, but B5 moves from "while we are here" to "required for a sane
first-login UX" under the cleaned production. Remedy: promote B5's Team.name
heal into the Part B critical path.

### 16. [minor] Sequencing omits the desktop/embedded clients.

`packages/client-core/src/auth-session.ts` (`switchUoaWorkspace`,
`switchContext`) is consumed by desktop (`desktop/`) and mobile shells, not
just `admin/`. B2's "create workspace → switch" client flow is described only
against the admin switcher; the desktop client's auth-session surface will
silently lack "create workspace" (rule zero: capability unreachable on a whole
surface). Remedy: name the desktop/mobile doorway explicitly or record the
deliberate deferral.

---

## Security findings

### 17. [blocker] B2's relay as specified lets any signed-in user create structure in an org they do not belong to.

This is the composition of findings 1, 5, and 9, stated plainly because it is
the review's central refutation: today, `POST /org/organisations/:orgId/teams`
in backend mode (a) requires only the domain-hash bearer, (b) does not check
that any acting user is a member of `:orgId` (`resolveAndAuthorizeTeamOrg`
returns early with no actor; `team.service.base.ts`), (c) records
`actor_user_id: null` in audit (`uoa-org-roster.ts:47-53` docblock confirms
"UOA applies no owner/admin check of its own"). Nessie's planned relay (B2)
authenticates the *Nessie* user but, per the roster-relay precedent it cites,
passes no acting-user identity to UOA, and the plan's only stated gate is
"mirrors UOA's own rules" — rules that do not exist for this mode. Nessie's
local mirror of membership (`OrganizationMember` rows) is exactly the
"ambient context" scoping AGENTS.md rule-zero-2 forbids relying on, and
Nessie's local membership can lag UOA's (drift refresh only at login/rotation).
Exploit shape: user invited to org X (pending) or formerly of org X crafts
`POST /api/workspace/teams { orgId: X-external-id }` → Nessie relays → UOA
mints a team in org X with no creator membership → attacker now has a team
anchor in a foreign org; combined with Nessie's materialization-on-switch, the
attacker's next switch materializes local membership rows for a workspace UOA
never granted them (UOA DID create the team and DID NOT add them — but the
switch path materializes `ensureWorkspacePrincipal` memberships from the
*claims*, and the team now exists and is listed... this needs UOA's
session-choices to list it, which requires membership — so the end-state is
limited to orphan-team vandalism in foreign orgs, not membership theft; still
a cross-tenant write). Remedy: B2 must not ship until UOA's team-create
accepts and enforces an acting user (user-mode token relay, or a signed
`actor_user_id` + UOA-side live-membership re-check), AND Nessie independently
verifies ACTIVE membership in the target org via the roster relay immediately
before relaying the create.

### 18. [major] Relaxing one-org-per-domain silently changes `UoaInvitationOrgConflictError` semantics and the invite UX.

`packages/workspace-admin/src/uoa-org-roster.ts` defines
`UoaInvitationOrgConflictError` ("invitee already belongs to another
organisation on this domain") and the invite flow surfaces it in words. Under
N>1 that refusal *should* disappear for Nessie's domain — but the Nessie-side
copy, the admin invite UI, and any tests asserting the refusal all assume it
exists. The plan mentions the UOA-side probe fix (tombstone bug, verified:
`team-invite.service.acceptance.ts:119-130` matches on `org: { domain }` with
**no status filter**, so a LEFT/REMOVED membership blocks forever — also note
the same status-blind probe exists in `user-team-requirement.service.ts:214-227`
for its `findFirst`, though that path then checks `status !== 'ACTIVE'` and
deliberately returns null) but never says what the Nessie UX does when the
conflict stops firing. Remedy: A3's work item list must include "revise or
remove `UoaInvitationOrgConflictError` handling and its UI copy".

### 19. [minor] The A1 auto-create name derives from `user.name` OR EMAIL — PII in org names.

`org-placement.service.ts:122-124`: `deriveOrgNameFromUser({ name: user?.name,
email: params.email })` — an unnamed user's auto-created org is named from
their **email address**, which then appears in Nessie's switcher, directory
entries, and (pre-B5) `Organization.name` mirrors shown to any future
co-member invited to that "personal" org. The plan accepts UOA's naming
without comment. Remedy: flag in A1 that the org name is user-visible PII and
either force the chooser's name prompt for unnamed users or use a neutral
default.

### 20. [minor] `EXTERNAL_AUTH_FAILED` → `UOA_NO_WORKSPACE` naming must not widen enumeration.

B1 introduces a named refusal with remedy copy on the admin login screen.
Fine, but the same exchange path is hit by *unauthenticated* callers (login
callback). The named refusal must carry no information about whether the
*subject* exists / has invites — "you have no workspace" vs "no such account"
must stay indistinguishable. The plan doesn't say. Remedy: specify the refusal
copy is static and identical for all zero-workspace causes.

---

## Part C — missed consumers of `users.email` / `users.display_name`

The plan enumerates: adoption bridge, CLI super-admin, generic-OIDC keying,
"remaining lookups/dedup by email". Consumers it **missed**:

### 21. [major] Mention resolution is string-matched against `displayName` on every message write — dropping the column breaks mentions silently.

`packages/runtime/src/user-alerts.ts:25-46` (`resolveMessageMentions`) matches
`@name` against `members[].displayName`, fed by
`api/src/services/message-create.ts:135` and `worker/src/run/mention-alerts.ts:50-55`
(`select: { user: { select: { id, displayName } } }`). The C1 directory must
hydrate the mention candidate set for **every channel's member list on every
message create** — that is a far hotter path than "feed pages", it is
synchronous on the write path, and a cold/degraded directory silently turns
mentions into no-ops (no alert rows, no push). The plan's "degrade-not-fail"
answer is acceptable for *rendering*; for mentions, degradation is a
notification loss with a hard SLO flavour ("a capability that can stop working
owns the way a person finds out" — nobody finds out). Remedy: C1 must call out
mention resolution by name, decide its degraded behaviour (roster-relay
hydration per channel write? keep per-channel member-name cache?), and note
the cold-start cost is per-channel-member-list, not per-feed-page.

### 22. [major] Worker-side display names are read in at least 6 hot paths the plan's one-line "the worker needs the same directory" understates.

`worker/src/control/call-lifecycle.ts:34,58` (missed-call content embeds
`startedBy.displayName`), `worker/src/control/push-dispatch.ts:67,133,169`
(push body text), `worker/src/control/attention-dispatch.ts`,
`worker/src/run/pa-tools/message-destination.ts:110-133` (DM label),
`worker/src/run/pa-tools/conversation-search.ts:190,242` (search result
author names), `worker/src/run/mention-alerts.ts:50-55` (finding 21), and
`packages/workspace-admin/src/call-realtime.ts` +
`packages/workspace-admin/src/agent-record.ts` (agent owner names —
`membership.user.displayName`). These run in the worker process, which per
AGENTS.md rebuilds and restarts independently and may run with UOA unreachable
by design (worker egress). A per-process LRU primed "from the run's org roster
read" does not cover call-lifecycle/push pollers that never read a roster.
Remedy: enumerate these call sites in C1 and assign each either roster-primed
hydration or a stated degraded string; the push-notification copy path needs a
product decision ("Missed call from Member"?).

### 23. [major] `users.email` is rendered to clients by stable contracts the plan never lists.

`api/src/services/auth.ts:295` (`buildMeResponse` → `MeResponse.user.email`),
`api/src/contracts/users-presence.ts:231` (`UserRecordSchema.email:
z.string().email()` — REQUIRED, feeds every members/people list), and
`api/src/routes/projects.ts:131` (project members include `m.user.email`).
Dropping the column means every one of these contract fields must be hydrated
from the directory on every response, or the contract changes and every
consumer of `UserRecord` (admin members pages, `ProjectMembersDialog`,
`useChannelMentions`, etc. — ~40 admin files reference email/displayName)
renders degraded data. The plan treats email removal as a server-internal
lookup problem; it is equally a **wire-contract** problem. Remedy: C2 gains a
contract-audit item: list every schema field carrying email/displayName
(`contracts/auth.ts:50,58`, `contracts/users-presence.ts:231,250`,
message include at `api/src/services/messages.ts:24-35`) and decide
hydrate-vs-drop per field.

### 24. [major] The C2 adoption-bridge decision contradicts the schema and misstates what "no legacy rows" means.

C2 proposes: "keep a nullable `email` only on rows with `uoaSub IS NULL`…
null it on adoption, drop the uniqueness constraint's role as an identity
key". But (a) `User.email` is `String @unique` NON-nullable today
(`api/prisma/schema.prisma:878`); making it nullable-and-unique in Postgres
still permits many NULLs (fine) but the adoption bridge itself
(`workspace-principal.ts:95-113`) does `findUnique({ where: { email } })` —
with email nulled on adoption, the bridge can never fire twice for the same
address, which is the intent, but it also means a *second* pre-SSO account
sharing that email (the exact ambiguity the backfill left `uoaSub` NULL over)
can no longer be adopted at all — it fails closed with no remedy copy; and
(b) `initialDisplayName` (`workspace-principal.ts:37-38`) falls back to
`input.email` as the display name for brand-new rows, so C1/C2 ordering
matters: if display_name drops first, new rows' names come from claims only,
and `resolveIdentityDisplayName` deliberately returns undefined when the
provider only echoes the email — the plan never says what the rendering
fallback is when BOTH columns are gone and claims carry no name (the directory
holds `{displayName, avatarUrl}` keyed by user id — for a user with no
asserted name, what is the value?). Remedy: C1 must specify the no-name
rendering contract (short subject? "Member"?) as a decided default, and C2
must specify the second-legacy-account failure copy.

### 25. [minor] `users.pronouns` is NOT "unused" — it is exposed in `MeResponse` and editable via users service.

`api/src/services/auth.ts:299` (`pronouns: user.pronouns ?? undefined`),
`api/src/services/users.ts:230,276` (create/update writes it),
`packages/schemas/src/identity.ts:124`, schema `api/prisma/schema.prisma:902`.
"Unused" is only true if no client renders it; the plan should verify the
admin profile UI before claiming it (Admin `SettingsProfilePage` references
identity fields). Remedy: downgrade C3's claim to "no client renders it —
verified at <file>" or drop the column only after that check.

### 26. [minor] CLI super-admin is email-keyed — verified and plan-cited, but the re-key has an operational wrinkle.

`cli/src/super-admin.ts:14-63` resolves `where: { email }`. Re-keying by
`uoaSub` requires the operator to know a UUID-ish subject; the natural re-key
is the roster relay (operator types an email, CLI asks UOA for the subject) —
but the CLI talks to the local DB directly, not to UOA. Remedy: state the CLI
gains a UOA roster lookup or takes the local user id from the admin members
page.

---

## Simpler alternatives the plan overlooks

### 27. [major] B2 may not need a Nessie relay at all: UOA already ships the entire create-team UX in the hosted chooser.

`/auth/create-team` (verified `routes/auth/auth-create-team.ts:73-90` +
finalization) runs **inside the login-bridge flow** with the short-lived login
capability consumed in the same transaction as team + creator membership +
auth continuation — creator membership and role outcomes already correct, no
backend-mode authz hole, no finding-17 class, no finding-12 race (creation and
session finalization are atomic in one transaction). Nessie's "Add workspace"
button in `WorkspaceMenu.tsx:102-116` already round-trips to the UOA chooser
(`onAddWorkspace(ssoProviderId)`). The simplest B2 is: keep creation in the
chooser (it's already rendered, already policy-gated by `creatable_orgs` /
`allow_user_create_team`, and A2/A3's policy work lands there for free), and
Nessie's only work is the switcher copy. The plan's own open question #3
points at this and then the body of B2 builds the relay anyway. The relay buys
an in-app dialog; it costs the entire finding-17 authz surface, a new route, a
new client, and a create/switch race. Remedy: default B2 to the chooser-hosted
flow; build the in-app relay only if the chooser UX is rejected on product
grounds, and say so explicitly.

### 28. [minor] C1's in-memory directory may be unnecessary for the *rendering* half if roster hydration happens at the API boundary per response.

The plan builds a cross-process shared directory (`@nessie/workspace-admin`)
to serve render-time names. A simpler cut: hydrate names into API responses at
serialization time from the existing per-request roster relay (already
TTL-cached in the worker — `pa-tools/people.ts:42-58`), and keep
`avatarUrl`/`displayName` columns for the **message-history** use only, marked
non-authoritative as today. That concedes "Nessie persists a profile mirror"
for message rows (the thing Part C wants to end), so it's a genuine trade —
but it avoids the cold-start/degraded-mode complexity across worker pollers.
At minimum the plan should cost this alternative against the directory build.
Remedy: add an "alternatives considered" note to C1.

### 29. [minor] A2's five-path role unification has a cheaper frame: delete two of the five paths.

`user_needs_team` is off and the plan says keep it off; the public create path
and admin path could both delegate to one `createOrganisationWithOwner`
service. The plan proposes "fix in the services" but keeps all five paths
alive. Fewer paths, fewer role outcomes. Remedy: A2 explicitly consolidates
callers, not just outcomes.

---

## Sections that survive the attack

- **Part B3 (materialization reuse):** verified — the switch/login
  materialization under exact-tuple advisory locks is real
  (`workspace-context.ts:284-321`, `workspace-target.ts:52-70,112-162`,
  `external-organization.ts:28-40`), and routing new-team creation through it
  rather than a second provisioning path is correct. Survives (subject to
  finding 8's two-transaction note).
- **B4 (retiring local structural mutations):** `POST /api/teams`
  (`api/src/routes/teams.ts:66-115`), `POST /api/projects`
  (`api/src/routes/projects.ts:136-178`), and `CreateProjectDialog.tsx:26-30`
  verified as UOA-unbacked forks; the `membership-mode-gate.ts` pattern exists
  and is already imported by exactly those route files
  (`teams.ts:11`, `projects.ts:11`, `users.ts:11`). Survives.
- **B5's metadata purge:** writers verified at the cited lines; no readers
  found. Survives.
- **Part D consequences (Nessie side):** post-cleanup state is consistent with
  the 1:1 materialization model; no legacy-population hazard found beyond
  finding 15's name-placeholder note. The plan's "never delete user accounts"
  posture matches the adoption-bridge constraints. Survives, with finding 15.
- **The tombstone invite-probe bug:** verified
  (`team-invite.service.acceptance.ts:119-130` lacks a status filter);
  fixing it is correct under any A3 outcome. Survives.

## Verdict

The plan's architecture (UOA-only structure, relay + materialize, no second
directory persisted) is sound and well-grounded in the code. It is not
refutable in shape. It is refutable in three load-bearing details: the A1
auto-provisioner is not race-safe and A3 proposes removing its only race
guard while leaving the replacement undecided (findings 4, 11); B2's relay
has no enforceable acting-user concept on the UOA side today, making
cross-org team creation a real cross-tenant write hole unless the chooser
alternative (finding 27) or a UOA contract change lands first (findings 1,
5, 9, 17); and Part C's column drops touch mention resolution, push/call
copy, and three wire contracts the plan never enumerates (findings 21-24).
Blockers: 4, 11, 17. Recommended: land A2+tombstone fix, B1 classification,
B3, B4, B5 first; gate A1 on the advisory-lock fix; gate A3 on the decided
enforcement mechanism; replace B2 with the chooser-hosted flow unless product
rejects it.
