# In-app organisation and workspace creation over UOA's org API

Status: design, not implemented. Supersedes the redirect-based "Add workspace"
flow. Date: 2026-09-02.

## The problem

Today, creating a new organisation from inside Nessie costs a second
interactive login. The workspace rail's "Add workspace" button runs
`handleAddWorkspace` in `admin/src/layouts/admin-shell/WorkspaceSwitcher.tsx`,
which calls `startExternalSignIn(providerId, theme)` — a full OAuth redirect to
UnlikeOtherAI (UOA), where the person creates the organisation in UOA's chooser
and is bounced back through the whole SSO handshake. Every other workspace
operation (switching, accepting an invitation) already works silently against
UOA's HTTP API. Creation is the last holdout, and this document replaces it
with an in-app flow against the same API, with no redirect and no second
login anywhere in the happy path.

The constraint that shapes everything below is the standing invariant: UOA is
the sole authority for identity and for the organisation/team hierarchy, mapped
1:1 into Nessie (`Organization.externalOrgId` for the org, one `Team` with its
Project and `#general` per UOA workspace). Nessie therefore creates nothing
locally first; it asks UOA to create, and materialises the local mirror only
from what UOA proved.

## 1. Credential mode: backend mode, and the gates it shifts onto Nessie

The owner has decided: creation calls authenticate in UOA **backend mode** —
the per-domain hash bearer (`Authorization: Bearer SHA256(domain +
clientSecret)`) plus the signed config JWT resolved from `?config_url=`, with
both `X-UOA-Access-Token` and `X-UOA-Subject-Assertion` omitted entirely.
Nessie's signed config already advertises `org_features.backend_org_management:
true`, so the mode is open today and no UOA-side configuration change is
needed. This section is not about re-litigating that choice; it is about the
four consequences backend mode carries, because UOA itself spells them out:
with no acting user, UOA applies no per-member role check, attributes the audit
entry to the domain backend, rate-limits per domain rather than per user, and
does not apply `allow_user_create_org`. Each consequence lands on Nessie.

### (a) Nessie's own authorization gate

Backend mode means the product's own gate is the only authorization. Nessie's
gate for organisation creation is: the caller must hold a **valid Nessie
session whose live `OrganizationMember` row in their current organisation
carries the `owner` role**. Owner, not member: creating an organisation mints a
whole new tenancy container and makes the creator its UOA owner, and the
closest existing analogue in the product — workspace provisioning actions like
binding agents — is owner-gated. A member who wants a new organisation asks an
owner, exactly as they would for other structural changes.

Two properties of the gate matter as much as the role itself:

- **Re-read at call time.** The role comes from the live
  `OrganizationMember` row read inside the request handler, never from the
  session's enqueue-time claims. This is the same rule the personal-assistant
  provisioning tools follow (`agent_bind_channel` re-reads the acting
  membership rather than trusting `actorContext`), and it exists because a
  demotion between login and click must take effect immediately.
- **Reject, don't widen, non-UOA sessions.** The flow is only meaningful for
  UOA-bound sessions (`providerType === 'uoa'`, `uoaIdentity` present, a bound
  refresh credential) because the last leg — the workspace-switch grant —
  requires one. A local-only deployment has no UOA to create in and must not
  show the doorway at all, rather than offering a form that can only fail.

The gate lives in a new service function in `@nessie/workspace-admin` (the
package that already owns `uoa-org-request.ts` and the roster functions), so
that if a personal-assistant tool ever needs the same act it calls the same
function — the route-mirroring rule applies here as everywhere.

### (b) `owner_user_id` and the DomainRole precondition

Backend mode requires `owner_user_id` in the body, and it must be the caller's
UOA subject — `User.uoaSub` locally, the same `sub` the session's
`uoaIdentity` carries. UOA additionally requires that the named owner already
holds a DomainRole on Nessie's calling domain, which is true of anyone who has
ever signed in. The residual case — a session whose `uoaSub` somehow carries
no DomainRole — can only arise from data corruption or a mid-flight account
deletion in UOA; UOA answers it with a 400. Nessie maps that 400 (via
`UoaRosterRejectedError.upstreamCode`) to a 409 telling the person to sign out
and back in, which re-establishes the DomainRole. It is not worth a bespoke
recovery flow because it is not a reachable state of the normal product.

### (c) Audit attribution

In backend mode UOA's own audit entry says `via: domain_backend` — it does not
name the person. UOA is the authority for the hierarchy, but attribution of
*who asked Nessie to ask UOA* is Nessie's fact, and losing it would make every
organisation creation unattributable. Nessie therefore writes its own
`AuditLog` row in the same request that performs the creation, recording the
actor's `userId`, `uoaSub`, the session id, the requested organisation name,
the returned UOA org id, and the client-supplied idempotency key (see §4).
This is also what makes the partial-state matrix in §4 diagnosable after the
fact: the local audit row is the link between a person and an org UOA only
remembers as created by the domain backend.

### (d) The shared per-domain rate limit

User mode's 5/hour-per-user bucket becomes **one shared per-domain bucket** in
backend mode. Two consequences. First, a busy tenant's creations compete with
each other: a burst of organisation creations by different owners can exhaust
the bucket for everyone, so the failure surfaced to the person must say
"organisation creation is temporarily rate-limited for this Nessie deployment;
try again later", not imply anything about their own behaviour. Second, and
more important, it makes blind retries expensive for the whole tenant, not
just the retrying user — which is why §4 makes retries idempotent by
construction rather than advisory. Nessie additionally applies its own
per-user rate limit in front of the UOA call (one in-flight creation per user,
a small hourly cap per user), so a single scripted client cannot drain the
shared bucket and a 429 from UOA should be a genuine surprise rather than the
normal backpressure mechanism.

### (e) `allow_user_create_org` is Nessie's own flag, and cannot be the gate

In backend mode UOA does not apply `org_features.allow_user_create_org`, which
raises the question of whether Nessie should apply it instead. The honest
answer is that it **cannot meaningfully be the gate**, and it is worth being
precise about why, because the tempting framing — "honour the tenant's policy"
— is wrong here.

That flag is not an external tenant administrator's policy. It is set by
Nessie, in Nessie's own signed config JWT, hardcoded `true` in `buildConfigJwt`
(`api/src/services/uoa-auth.ts`). Its actual job is to tell UOA's chooser UI
whether to offer a create option during an interactive login. A gate in which
Nessie checks a constant Nessie itself authored is a tautology dressed as an
authorization check, and writing it as though it defended something would
mislead the next reader into thinking creation was policy-controlled when the
only real control is §1(a).

So: the flag is **not** consulted as an authorization gate. The gate is §1(a)'s
live `owner` role, full stop. The flag keeps its real job — it stays `true` so
the SSO chooser continues to offer creation for the first-organisation case
that still legitimately goes through UOA's UI (a person with no organisation at
all, who has no Nessie session to gate). If a future deployment wants creation
genuinely disabled, that is a deployment-level setting governing §1(a)'s route,
and it should be introduced as one rather than smuggled in through a config
field that also drives an unrelated UOA screen.

## 2. Closing the default-team gap: an additive field on the create response

`POST /org/organisations` creates, in one transaction, the Organisation, a
default Team named "General" (`isDefault: true`), the owner's `OrgMember` row,
and the owner's `TeamMember` row on that team — but its response is the
organisation record only:

```json
{ "id", "domain", "name", "slug", "ownerId", "memberInvites", "iconUrl",
  "createdAt", "updatedAt" }
```

The whole in-app flow is blocked without the default team's id, because the
last leg — `POST /api/auth/uoa/workspace` — needs `{organizationId, teamId}`
to run the switch grant. The owner has authorized changing UOA itself and
deploying it, so the preferred answer is the clean one: **return the default
team the route already creates, in the same transaction, as an additive
response field.**

### The upstream change, specified

Add to the `POST /org/organisations` response a field carrying the default
team record:

```json
"defaultTeam": { "id", "organisationId", "name", "isDefault", "createdAt",
"updatedAt" }
```

The change is small because the data already exists at the moment the response
is serialised — the transaction that inserts the Organisation also inserts
that Team row. Concretely, in the UnlikeOtherAuthenticator repo:

- The field is added to the **create route's response only**, NOT to the
  shared `toOrganisationRecord` serialiser. That distinction is load-bearing:
  `toOrganisationRecord` (`API/src/services/organisation.service.base.ts`) is
  shared by the create path, the single-org read, AND the domain-wide list, so
  teaching it about the default team would add a team lookup to every row of
  every list page to serve one caller that already has the id in hand.
  `createOrganisation` in
  `API/src/services/organisation.service.organisation.ts` already holds
  `defaultTeam.id` in scope inside its transaction — it selects only `{ id }`
  today, so it widens that select and returns
  `{ ...toOrganisationRecord(createdOrg), defaultTeam }` while every other
  caller of the serialiser is untouched.
- Per that repo's own standing rule, adding or changing an endpoint's contract
  means updating BOTH `API/src/routes/root/index.ts` (the endpoint schema) and
  the `/llm` config docs — they are the machine-readable API contract, and a
  change that skips them is incomplete there.
- The served `/api` and `/llm` contract docs gain the field in the create
  response schema.
- The contract tests gain a case asserting `defaultTeam.id` is present, that
  `defaultTeam.isDefault === true`, and that the owner's `TeamMember` row
  points at it.

**Why additive is sufficient:** every existing consumer parses the fields it
knows and ignores the rest — that is how the record has evolved to date — so
no current caller of the create route, the list route, or the single-org read
breaks. No consumer keys behaviour on the *absence* of a `defaultTeam` field.
The change is a deployment, not a migration.

### The deployment window

UOA deploys independently of Nessie, so there is a window in which Nessie
ships code that wants `defaultTeam` against a UOA that does not yet return it.
Nessie must treat the field as **optional on read** and fall through to the
fallback below when it is absent. It must not fail the creation when the field
is missing — the organisation exists in UOA by then, and refusing would strand
it (see §4).

### The fallback, and whether it stays

The fallback is a follow-up backend-mode `GET /org/organisations/:orgId/teams`
through the same `rosterRequest` seam. It works in backend mode today (backend
mode additionally lists hidden teams), needs no upstream change, and returns
the full team list, from which Nessie picks the `isDefault` entry (or, during
the window, the single team the transaction just created).

Which to ship: **the additive field is the primary path; the fallback ships
with it and stays permanently.** The fallback is not a compatibility shim to
delete after the window — it is the defensive read for the one failure the
primary path cannot see: a response truncated or transformed by an
intermediary, or a future UOA regression that drops the field. The cost of
keeping it is one conditional request; the cost of removing it is that a
schema drift upstream turns into stranded organisations. The resolution order
is: use `defaultTeam.id` when present and well-formed; otherwise `GET
/org/organisations/:orgId/teams` and pick `isDefault`; if that read fails or
contains no default team, surface the failure with the organisation id so
support can reconcile — the org exists in UOA and the person's next `/org/me`
priming read will see it (§4).

## 3. The end-to-end sequence

One client action, one Nessie route, four ordered steps. New route:
`POST /api/org/create` (working name; lives beside the roster routes, body
`{ name, memberInvites?, iconUrl?, idempotencyKey }`). Every UOA call goes
through `rosterRequest` from `packages/workspace-admin/src/uoa-org-request.ts`
— the single `/org/*` seam with the domain-hash bearer, `safeFetch` IP-pinned
egress and `maxRedirects: 0` — with **no** `deps.subjectAssertion`, which is
what makes each call backend mode.

1. **Gate (local, no UOA call).** `requireActorContext`; verify the session is
   UOA-bound; re-read the live `OrganizationMember` row and require `owner`;
   check `allow_user_create_org` from the resolved config; check the Nessie
   per-user creation rate limit and the idempotency-key ledger (§4). Failure
   disposition: 403 for role/flag/session-shape, 429 for the local limit, 409
   with the prior result for an idempotency-key replay — nothing has touched
   UOA, so nothing needs reconciling.
2. **Create in UOA (backend mode).** `rosterRequest(settings,
   '/org/organisations', { method: 'POST', body: { name, member_invites,
   icon_url, owner_user_id: user.uoaSub } }, {})`. Failure disposition:
   `UoaRosterRejectedError` maps by `statusCode`/`upstreamCode` — 400
   owner/DomainRole problems to 409 ("sign out and back in"), 429 to 429 with
   the shared-bucket message, others to 400 with UOA's code preserved;
   `UoaRosterUnavailableError` to 503. Nothing exists yet in UOA on a 4xx, so
   the idempotency ledger records the refusal and a retry with the same key is
   allowed to proceed.
3. **Resolve the default team (backend mode).** Read `defaultTeam.id` from the
   step-2 response; if absent, `rosterRequest(settings,
   orgPath({externalOrgId}), ...)`'s sibling `GET
   /org/organisations/:orgId/teams` and pick `isDefault`. Failure disposition:
   the organisation now **exists in UOA** — this is the first step whose
   failure leaves partial state, handled in §4. Record the audit row here (or
   immediately after step 2) with the org id and resolved team id.
4. **Switch onto the new workspace (existing route, unchanged).** The client
   calls `POST /api/auth/uoa/workspace` with `{organizationId, teamId}` exactly
   as it does for any rail switch. That route runs the
   `urn:unlikeotherai:params:oauth:grant-type:workspace-switch` grant against
   the bound refresh credential, UOA proves the membership (the owner was
   granted `OrgMember` + `TeamMember` rows in the step-2 transaction, so the
   grant's own access check passes), rotates the local session, and —
   critically — calls `materializeUoaWorkspace(prisma, {identity, userId})`
   from `api/src/services/uoa-workspace-switch.ts` with the workspace UOA
   itself proved in the grant response.

**Where the local `Organization` row is born:** inside
`materializeUoaWorkspace`, and nowhere else. It is idempotent, keyed on
`Organization.externalOrgId`, and its input is a workspace UOA authenticated —
which is precisely the invariant "Nessie materialises the local mirror from
what UOA proved." The creation route in step 2–3 deliberately does **not**
create the local row: doing so would be inventing a local org ahead of a UOA
proof, the exact violation the hard rule names. The `Team`, its Project and
`#general` are born in the same materialisation. The client then lands on the
new workspace exactly as it does after any switch: `reconcileSession` and
`navigate('/channels', { replace: true })`.

One sequencing note: steps 2–3 run in the creation route's request; step 4 is
a separate client call, matching how the rail already composes switch + land.
Keeping the switch as its own call means the creation route has no session
mutation to roll back if the grant later fails, and reuses the switch route's
existing, tested failure taxonomy (`INTERACTION_REQUIRED`,
`WORKSPACE_NOT_AVAILABLE`, `WORKSPACE_SWITCH_CONFLICT`, …) unchanged.

## 4. Partial-state and idempotency

UOA's writes and Nessie's are not transactional with each other, and UOA is
the authority: "roll back" is rarely available, and the honest recovery is
reconciliation on the next authoritative read. The states:

| State | What is true | Recovery |
|---|---|---|
| Org created in UOA; default-team resolution failed | UOA has the org; Nessie has only the audit row | The person's next `/org/me`-primed directory read (`fetchUoaWorkspaceDirectory`, which runs at exchange/refresh) lists the new workspace in the rail; they switch to it like any other. The creation response already told the client the org id, so the client can also offer "open it" via a plain switch once a session refresh has primed the directory. |
| Org + team resolved; switch grant failed | UOA has the org; local row does not exist yet | Same mechanism — the next directory prime shows the workspace and a normal `POST /api/auth/uoa/workspace` both switches and materialises. Nothing is stranded: materialisation happens on first successful switch, whenever that occurs. The UI reports the switch failure with the existing `workspaceSwitchFailureMessage` vocabulary and leaves the person in their current workspace. |
| Switch succeeded; materialisation failed | Session rotated onto a workspace with no local mirror | This is the pre-existing failure mode of the switch route, not new to creation; its recovery (`recoverWorkspaceSwitchFailure` + session reconcile) already exists and applies unchanged. |
| Double-submit | Two clicks, one intent | The idempotency mechanism below makes the second click a 409 returning the first request's outcome, not a second organisation. |
| Retry after a network timeout of unknown outcome | The client does not know whether UOA created the org | Without idempotency this mints a **second** organisation with the same name — UOA derives a unique slug, so nothing upstream deduplicates, and in backend mode the retry spends the shared per-domain bucket rather than the person's own. This is the case the mechanism exists for. |

**The idempotency mechanism.** The client generates a UUID `idempotencyKey`
when the form is first submitted and re-sends it on every retry of the same
logical creation. The creation route keeps a small ledger — keyed
`(userId, idempotencyKey)`, unique — whose row is inserted in the same gate
step, before any UOA call, and updated with the outcome (`created` + the UOA
org/team ids, or the refusal class). A replay with a known key returns the
recorded outcome (201 with the same ids, or the same refusal) without touching
UOA. A replay whose key row exists but has no outcome yet (the first request
is still in flight, or died between the UOA write and the ledger update) is
answered 409 "creation already in progress" and the client polls — the window
is one HTTP request wide, and the ledger row carries the org id as soon as
step 2 returns, so the poll resolves quickly. Because the ledger insert
happens before the UOA call and the unique constraint is the gate,
double-submits serialise on the database rather than racing into two UOA
creates. Ledger rows expire after 24 hours — long enough for any human retry,
short enough that the table stays trivially small. This mirrors the shape of
the queue's idempotency keys (`run:batch:` etc.): the database unique
constraint is the mechanism, not application-level checking.

## 5. Creating a further workspace inside an existing organisation

A genuinely different, simpler case: the person is an owner of organisation A,
is currently scoped to A, and wants another workspace (UOA team) inside it.
Here `POST /org/organisations/:orgId/teams` takes `:orgId` **equal to the
person's current active org**, so the user-mode assertion binds cleanly —
`active.orgId` equals `:orgId` exactly, which is the binding UOA requires —
and no mode-mixing arises.

Design: this path uses **user mode**, not backend mode. The call goes through
the same `rosterRequest` seam but with `deps.subjectAssertion` set, minted by
the existing `withUoaRosterSubjectAssertion(...)` from
`packages/workspace-admin/src/uoa-org-roster.ts` — the ≤60 s product-signed
RS256 assertion whose `active: { orgId, teamId }` names the person's current
workspace. User mode is right here for the reasons backend mode was wrong
there: UOA's own per-member role gate applies (only people UOA considers
owners/admins of that org may add teams — a stronger and more current check
than Nessie's), audit attribution names the person, and the rate limit is the
per-user bucket. `allow_user_create_team` is enforced by UOA itself in this
mode, so no local policy mirror is needed. The gate Nessie adds on top is
only session-shape (UOA-bound session, `:orgId` equals the session's active
org — otherwise refuse and tell the person to switch first, because an
assertion minted from the current session cannot validly name any other org).

The response of the team-create route includes the team id (no default-team
gap here — teams are created directly), so the flow is: gate → user-mode
`POST /org/organisations/:orgId/teams` with `{ name }` →
`POST /api/auth/uoa/workspace` with `{organizationId: :orgId, teamId}` →
materialisation on switch, exactly as §3 step 4. Idempotency uses the same
ledger mechanism with the same client-generated key; the blast radius of a
blind retry here is only a duplicate team, but the per-user bucket still makes
the ledger worthwhile, and one mechanism serving both flows beats two.

**Distinguishing the two in the UI without a second doorway.** There is one
doorway — the workspace rail's menu — and one dialog. Inside the dialog, a
`TabBar` (the single-select strip primitive, never a bespoke segmented
control) offers two options: **"New organisation"** and **"In this
organisation"** (rendered with the active organisation's name — "In
Acme Ltd"). The second option exists only when the person is an owner of the
active organisation; the first only when `allow_user_create_org` holds. When
exactly one option is available the strip is omitted and the form simply is
that flow — an owner of their only org who cannot create orgs sees just the
workspace form, and vice versa. Both options submit to their respective route
and converge on the same switch-and-land tail, so the person never needs to
know which credential mode carried their request.

## 6. The admin surface

**Owning surface (Rule zero):** the workspace switcher in the rail —
`WorkspaceSwitcher` / `WorkspaceMenu` under
`admin/src/layouts/admin-shell/` — remains the one home for "which workspace
am I in, and how do I get another." **In-context doorway:** the existing "Add
workspace" item in that menu is the doorway; it is joined, inside the same
dialog, by the "In this organisation" form for workspace creation. No new
entry point appears anywhere else, and none is needed: the question "how do I
get another workspace/organisation?" arises exactly where the person is
standing when they open the workspace menu.

What replaces the redirect: `handleAddWorkspace` stops calling
`startExternalSignIn` and opens a **centred `components/shared/Dialog.tsx`**
— no eleventh bespoke modal shell. The dialog contains no nested cards: a
title, the optional `TabBar` strip choosing between the two flows (§5), and a
plain labelled form. The form asks **name** (required) and nothing else.

The two other fields UOA's create accepts are deliberately omitted.
`member_invites` is **not** an invite list — it is the organisation's
member-invite POLICY, the enum `allowed | admin_approval | disabled`, and
UOA's own default (`allowed`) is the right one for a brand-new organisation;
asking a person to choose an invite-approval policy before they have a single
colleague is a decision with no information behind it. `icon_url` has an
established home already — the workspace avatar surface — and duplicating it
here would be a second doorway to the same setting. Both remain editable
through `PUT /org/organisations/:orgId` afterwards. There is no slug field
either: UOA derives the slug. Every element must name the decision it drives,
and at creation time only the name does.

States, all rendered inside the dialog (the rail menu closes when the dialog
opens, so there is exactly one surface showing progress):

- **Idle**: the form. The submit button carries the flow's verb — "Create
  organisation" / "Create workspace".
- **In flight**: submit disabled, the dialog shows a single spinner row naming
  the step in person terms ("Creating in UnlikeOtherAI…", then "Opening your
  new workspace…"). The idempotency key is minted here and held in component
  state for any retry.
- **Failure**: the refusal replaces the form's footer — role/flag refusals in
  the gate's own words, the shared-bucket 429 message from §1(d), UOA 4xx with
  the upstream code preserved, and the switch tail's failures through the
  existing `workspaceSwitchFailureMessage` vocabulary. The form keeps its
  values so a retry is one click with the same idempotency key.
- **Success**: the dialog closes on the switch route's success and the client
  runs the same tail as a rail switch — `reconcileSession`,
  `navigate('/channels', { replace: true })` — landing the person in the new
  workspace's `#general` with the rail avatar updated by the directory prime
  that the session rotation triggers.

The desktop rail, mobile web header and native bridges already render this one
switcher (`variant` prop), so all three get the in-app flow by changing it in
one place — the surface is reused, not forked.

## 7. What must NOT happen

An explicit list, so a later implementer cannot drift:

- **No local org invented ahead of UOA.** The `Organization` row is born only
  inside `materializeUoaWorkspace`, from a workspace UOA proved. The creation
  route never writes one.
- **No second copy of the hierarchy.** Nessie stores the mirror rows and the
  audit/ledger rows — nothing that restates UOA's structure as a parallel
  source of truth. The roster of the new org's teams is read from UOA, not
  cached.
- **No plain `fetch`.** Every UOA call goes through `rosterRequest` /
  `safeFetch` with IP-pinned egress and `maxRedirects: 0`. No new egress path,
  no "just this once."
- **No redirect anywhere in the happy path.** `startExternalSignIn` and
  `startWorkspaceSwitchReauthorization` keep their existing roles — initial
  login, and recovery when a switch's target proof is non-renewable — and
  creation never calls either.
- **No `owner_user_id` on a user-mode call** (UOA answers
  `400 OWNER_NOT_ALLOWED`), and no user-mode header on the organisation-create
  call — it is backend mode by decision, and mixing modes is how the
  `active.orgId` binding turns into a `403 INSUFFICIENT_ORG_ROLE` that names
  nothing.
- **No blank credential header.** A header present but blank is
  `401 MISSING_ACCESS_TOKEN`, not "omitted"; backend mode is expressed by the
  headers' *absence*, which `rosterRequest` already guarantees by omitting
  `X-UOA-Subject-Assertion` unless `deps.subjectAssertion` is set.
- **No bypass of Nessie's own gate.** The owner-role re-read, the
  `allow_user_create_org` check and the per-user rate limit run on every call,
  including retries with a fresh idempotency key. The idempotency ledger
  short-circuits UOA, never the gate.

## Acceptance criteria

Observable, testable:

1. An owner with a UOA-bound session opens the rail menu, chooses "Add
   workspace", enters a name, submits — and lands in the new organisation's
   `#general` with no redirect, no second login, and the new workspace present
   in the rail list. Verified end-to-end with Playwright on
   `http://localhost:5455`.
2. The local `Organization` row exists with `externalOrgId` equal to the UOA
   org id returned by `POST /org/organisations`, and was written by
   `materializeUoaWorkspace` (no other code path writes it in this flow).
3. A member (non-owner) sees the organisation flow refused by the gate with
   403, and UOA's logs show no create call was made.
4. Double-submitting the form (two clicks before the first response) produces
   exactly one UOA organisation; the second click observes the recorded
   outcome.
5. A retry with the same idempotency key after a simulated network failure
   produces no second UOA create call; a retry with a new key does (and is the
   caller's explicit choice).
6. Against a UOA build without the `defaultTeam` field, the flow completes
   via the fallback team-list read; against one with it, no fallback call is
   made.
7. The workspace-in-current-organisation flow issues a user-mode call
   (assertion present, no `owner_user_id`), and succeeds only for people UOA
   itself gates as owners of that org.
8. With `allow_user_create_org` off in the deployment's config, the
   organisation doorway is hidden and the route refuses.
9. The audit row names the creating user, the UOA org id and the idempotency
   key for every successful creation.

## Verified against source (2026-09-02)

The claims this design leans on were checked against
`UnlikeOtherAuthenticator` `origin/main` and this repo, not inferred:

- **The switch grant succeeds for a brand-new organisation** — the one
  assumption that would have invalidated §3 step 4 outright. The switch path
  runs `confirmUoaWorkspaceSwitchAccess` →
  `confirmUoaDirectServiceAccess` → UOA's `POST
  /billing/v1/service-access/confirm`, whose service
  (`confirmAuthenticatedDirectBillingServiceAccess`) requires an `OrgMember`
  row with `status = ACTIVE` **and** an active `TeamMember` on a team in that
  org, else `403 BILLING_SUBJECT_NOT_ENTITLED`. UOA's `createOrganisation`
  writes both rows in its creation transaction without naming a status, and
  both columns are `MembershipStatus @default(ACTIVE)` in UOA's schema. The
  founder is therefore entitled the instant the org exists, with no
  subscription, tariff or billing setup in between.
- **The create response really does omit the default team** —
  `ORGANISATION_SELECT` in `organisation.service.organisation.ts` selects
  `id, domain, name, slug, ownerId, memberInvites, iconUrl, createdAt,
  updatedAt`, and `toOrganisationRecord` serialises exactly those. §2 is a real
  gap, not a defensive one.
- **The assertion binding is what forces backend mode for the resolve step** —
  UOA's `org-role-guard.ts` compares `active.orgId`/`active.teamId` against the
  route params and additionally requires `org.teams.includes(active.teamId)`,
  throwing `403 INSUFFICIENT_ORG_ROLE` otherwise. A user-mode assertion
  provably cannot address the new organisation before its team id is known.
- **Both credential modes are open today** — Nessie's `buildConfigJwt` already
  advertises `org_features.enabled`, `allow_user_create_org`,
  `allow_user_create_team` and `backend_org_management`, all `true`. No UOA
  configuration change is required; only the additive response field of §2.
- **`member_invites` is the enum `allowed | admin_approval | disabled`**
  (`CreateOrgBodySchema`/`OrgBodySchema`), not an invite list — see §6.

## Open questions for the owner

Genuinely undecidable from here — the upstream UOA change is approved and is
not listed:

1. **Should members ever create organisations?** This design gates on the
   owner role, matching the product's other structural actions. If the owner
   wants any member to be able to found a new organisation (UOA's user mode
   would have allowed it under `allow_user_create_org`), that is a product
   decision that changes §1(a) and the dialog's visibility rules.
2. **Should the new organisation's first colleagues be invited from the same
   dialog?** Not via `member_invites` — that field is the invite-approval
   policy, not a list of people (§6). The real question is whether creation
   should chain into the existing team-invitation flow
   (`POST /org/organisations/:orgId/teams/:teamId/invitations`, already wired
   into the Members surface) once the switch has landed, or whether founding
   bare and inviting from the member directory afterwards is enough. The latter
   is assumed here.
3. **Naming of the new route and the ledger's home.** `POST /api/org/create`
   and a dedicated ledger table are working choices; if the roster routes have
   an established naming convention this should follow it, and if there is an
   existing generic idempotency store the ledger should live there instead.
