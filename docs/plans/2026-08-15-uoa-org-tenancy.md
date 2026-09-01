# One Nessie Organization per UOA organisation

> **Status:** In flight (2026-08-15). Two implementing branches:
> `task/org-tenancy-core` (provisioning, session, switch) and
> `task/org-tenancy-partition` (the data migration). This document is the
> design they implement.
> **Scope:** `api/` (schema, workspace provisioning, workspace switch, session
> scoping), `api/prisma/migrations` (the partition migration), and every
> org-scoped read that inherits the new boundary.
> **Supersedes:** the "Model decision" section of
> [2026-07-10-slack-workspace-login-nessie.md](2026-07-10-slack-workspace-login-nessie.md)
> — the one-shared-local-`Organization` flattening. Everything below the org
> level in that plan (workspace → Project + Team + `#general`, the switcher,
> the switch routes) is unchanged.
> **Resolves:** ambiguity 5 of
> [2026-08-14-uoa-sso-gap-analysis.md](2026-08-14-uoa-sso-gap-analysis.md).
> **Companion:** UnlikeOtherAuthenticator (UOA) — the organisation model and
> claims consumed here are the ones documented at
> `https://authentication.unlikeotherai.com/llm` and `/api`.

## Why now

The 2026-07-10 model was built against a UOA that gave each user **one org and
many teams**. Under that constraint the UOA org id was worthless as a tenancy
key — every user had exactly one, and mapping a workspace to a whole
`Organization` would have meant provisioning a tenant per team. So Nessie
flattened: **one shared local `Organization`** holding every workspace as a
Project + Team, with the UOA org id kept on `Team.externalOrgId` for
traceability only and the switcher grouping rows by that id purely as a display
concern.

UOA has since moved to a relationship-based access model (ReBAC) in which
**organisations are first-class**: a user can belong to several organisations,
and a workspace (team) is always created *within* one of them. The
one-org-per-user assumption the flattening rested on is gone, and with it the
reason to flatten. What remains is a real defect: two customers who happen to
sign into the same Nessie instance from two different UOA organisations land in
one local container, sharing a member directory, a budget, an audit log, and
org settings. The local model is no longer a lossy-but-harmless projection of
UOA's; it is a *different* structure, which the UOA identity-authority rule in
[../brief.md](../brief.md) forbids for the same reason it forbids a second copy
of a user row.

## Model

One Nessie `Organization` per UOA organisation, keyed on the stable UOA
organisation id:

```prisma
model Organization {
  // …
  externalOrgId String? @unique @map("external_org_id")
}
```

| UOA | Nessie |
|---|---|
| organisation | `Organization` (`externalOrgId` = UOA org id) |
| workspace (team) | `Project` + `Team` + `#general`, inside that Organization (`Team.externalWorkspaceId`, unchanged) |
| org role (`org_role` claim) | `OrganizationMember.role` for **that** organisation |
| team role (`team_roles[workspaceId]`) | `TeamMember.role`, unchanged |

- **`externalOrgId` is nullable, and null means local.** A `local`/`selfHosted`
  install with no IdP keeps exactly one unbound `Organization`; nothing on that
  path changes. `@unique` is what makes resolve-or-create idempotent under
  concurrency, and it is why the column is nullable rather than defaulted —
  Postgres treats NULLs as distinct, so unbound local orgs never collide.
- **Below the org level nothing changes.** A workspace is still a Project + a
  Team + a `#general` channel; channels, agents and policy evaluation still
  scope by the active `proj`/`team`. The only difference is which
  `Organization` those rows hang from.
- **The org name is a non-authoritative mirror**, following the same
  profile-mirror doctrine as `User.displayName` (gap analysis phase 3 step 1):
  UOA owns it, Nessie stores a copy solely so a row has a label, re-synced from
  the verified `orgName` the directory supplies and never edited into a second
  authority. An organisation materialized before any name is known carries the
  placeholder `Organisation <id-prefix>` until the directory supplies the real
  one. A local edit of an SSO-owned org name is not a supported operation.

## Provisioning and session semantics

`resolveUoaWorkspaceContext` (`api/src/services/workspace-context.ts`) stops
asking for "the shared organization" and asks for *this claim's* organisation.

- **Resolve-or-create by `externalOrgId`, under an advisory lock keyed on that
  id.** The `organization.findFirst({ orderBy: { createdAt: 'asc' } })` lookup
  is deleted from the UOA path — the globally-oldest-row lookup was always a
  stand-in for a key that did not exist, and it is the same lookup `AGENTS.md`
  calls out as a globally-scoped production read that concurrent test suites
  cannot survive. The lock makes two simultaneous first logins into a new
  organisation produce one row, not two, and the unique index is the backstop
  if they somehow race past it.
- **First entry into a new organisation takes its org role from the claim.**
  An `org_role` of `owner` makes that person the organisation's owner. When UOA
  sends no `org_role` at all, the **first materializer owns the organisation** —
  the same rule that already governs a workspace's first materializer, applied
  one level up, so a freshly created organisation is never left with nobody who
  can administer it.
- **The last-owner projection floor is removed for UOA organisations.** It
  existed (`uoa-roles.ts` `projectOrgRole`, gap analysis phase 4) precisely
  because a per-UOA-org `org_role` was *not* a complete statement about who
  administers a container shared by every UOA organisation, and because the
  SSO-first bootstrap owner would demote themselves on their own first login.
  With one Organization per UOA organisation both reasons are gone: the claim
  is now a complete statement about that organisation, and honouring it is the
  point. The floor **stays** on the local-mode mutation routes
  (`organization-owner-lock.ts` `wouldRemoveLastOwner` as called by the local
  membership mutators), which govern an unbound local org where no upstream
  authority exists. Instance-global administration remains `User.superAdmin`,
  which is not an org membership and is unaffected either way.
- **Cross-org workspace switching is legitimate, not an error.** The UOA
  directory can offer workspaces in several organisations, so
  `POST /api/auth/uoa/workspace` resolves the *target* organisation the same
  way login does — materializing the `Organization` (and the user's
  `ProductAccountLink` for it) on first entry — and then materializes the
  workspace inside it. The switch's existing guarantees are untouched: UOA
  authorizes the target, the returned session must match the exact requested
  org/team, and a refused switch never logs anyone out. What changes is that
  the resolved local organisation may differ from the session's previous one,
  and every tenant-scoped query the client holds is invalidated accordingly —
  the switcher already clears tenant queries when the active
  organisation/project/team changes.

## Migration — adopt one, split the rest

The partition migration runs at deploy against installs whose single
`Organization` holds teams from more than one UOA organisation.

**Classification.** Every `Team` already carries `externalOrgId` (2026-07-10,
"for traceability"), which is exactly the fact needed to partition. Teams with
no `externalOrgId` are local/legacy and never move.

1. **The existing organisation adopts the plurality external org id** — the UOA
   organisation with the most teams in it. Ties break to the **oldest team's**
   external org id, so the outcome is deterministic and does not depend on scan
   order. Adoption is a single `UPDATE organizations SET external_org_id = …`;
   no rows move, which is what keeps the common single-organisation install a
   no-op and keeps the largest tenant's data exactly where it is.
2. **Every other external org id splits into a new `Organization`**, named from
   the directory when a name is available and `Organisation <id-prefix>`
   otherwise. For each, the migration moves **the whole workspace subtree** —
   the `Project` and `Team` and everything scoped beneath them, including the
   `organization_id` denormalization every child table carries — into the new
   organisation.
3. **Per-user memberships follow.** A user who has teams in a split
   organisation gets an `OrganizationMember` row there, seeded with the
   **maximum of their team roles** in that organisation (owner > admin >
   member). This is a seed, not an authority: the claim projection corrects it
   at that user's next login, which is the whole point of memberships being a
   projection.
4. **Org-global rows stay with the adopter.** Organisation settings, the logo
   attachment, budgets and policies defined at org scope, and audit rows that
   cannot be attributed to a moved subtree remain on the adopting organisation.
   Audit history is append-only and hash-chained; rewriting its tenancy would
   break the chain, so unreachable rows stay where they were written and the
   split organisations start their own chains.
5. **Product account links follow the user.** A user left with **no** membership
   in the old organisation has their `ProductAccountLink` rows moved to the
   organisation they actually belong to; a user who spans both keeps a link in
   each. A link is per (user, organisation, product), so a user in two
   organisations legitimately holds two.

**Sessions.** An access session and its refresh family are bound to
`{sub, org, team, tv}` and to the local organisation they were issued for.
Sessions belonging to the **adopting** organisation survive the migration
untouched — the row they point at is the same row. Users whose workspaces moved
into a **split** organisation must sign in once after deploy: their next
refresh no longer matches the local organisation the family was bound to, so
the family re-homes at the next interactive login. This is one re-login on the
deploy, not a recurring cost, and it is the honest outcome — the alternative
(rewriting live session bindings across a tenancy change) is exactly the kind
of compatibility shim this codebase refuses.

## Tenancy consequences

These follow from the model rather than being separate features, and are worth
stating because they are what customers will notice:

- **Budgets** (`Budget`, spend gates, threshold alerts) are per UOA
  organisation. Two organisations no longer share one spend envelope.
- **Policies** — the deny-overrides engine's org-scoped subjects and rules
  resolve within the caller's organisation.
- **Audit log** is per organisation, with its own chain.
- **Member directory** — `GET /api/workspace/members` and the roster relays
  already key on the UOA organisation id taken from the mapped `Team`; they now
  agree with the local container rather than cutting across it.
- **Organisation settings** (name mirror, logo, `stripImageMetadata`) are per
  organisation.
- **Rule zero, check 2** — lists are scoped by entitlement. Per-org tenancy
  narrows what a caller is *entitled* to see; it must not become a new ambient
  narrowing of lists inside an organisation the caller does reach.

## Verification

What the implementing branches are expected to prove:

**`task/org-tenancy-core`**

- First login into a **new** UOA organisation creates exactly one
  `Organization` with the claim's `externalOrgId`, and two concurrent first
  logins into that same organisation produce one row (advisory lock + unique
  index), asserted against a real Postgres.
- Second login into an **existing** UOA organisation resolves the same row and
  creates nothing.
- The `org_role` claim is projected verbatim, including a demotion from owner:
  the last-owner floor no longer suppresses it for a UOA organisation, while
  the local-mode mutation routes still refuse to remove the last owner.
- No-claim first entry makes the materializer the organisation's owner.
- A workspace switch to a workspace in a **different** UOA organisation
  materializes that organisation and its account link, lands the session on it,
  and still refuses a target UOA did not authorize.
- Local mode and generic (non-UOA) OIDC are byte-identical: no `externalOrgId`
  is written, and the single unbound organisation is resolved as before.
- The globally-oldest-`Organization` lookup is gone from the UOA path — which
  also removes the shared-database test hazard `AGENTS.md` documents.

**`task/org-tenancy-partition`**

- Applied to a seeded shared organisation holding teams from three UOA
  organisations: the plurality one is adopted in place, the other two split,
  every moved subtree keeps its rows and its `organization_id` denormalization
  consistent, and no row is orphaned.
- Tie on team count resolves to the oldest team's external org id, twice, from
  different scan orders.
- A single-UOA-organisation install is a pure adoption: zero rows move.
- Seeded memberships equal the max of each user's team roles per organisation,
  and are corrected by the claim projection at the next login.
- Users left with no membership in the old organisation have their product
  links moved; users spanning both keep one link each.
- The migration converges on the checked-in upgrade fixture
  (`upgrade-path` CI job), and the migration folder is immutable once
  committed.

## Follow-ups

- **Directory-supplied names.** The placeholder `Organisation <id-prefix>` must
  be replaced on the first directory read that carries `orgName`; a
  long-running instance should never still be showing placeholders.
- **Org-scoped surfaces still assuming one org.** Any admin surface that reads
  "the organisation" rather than the session's organisation needs an audit pass
  — Rule zero, check 2.
- **Deactivation across organisations.** Reflecting a UOA membership removal
  onto the matching Nessie organisation (the open follow-up from the 2026-07-10
  plan) now has a per-organisation target rather than a shared one.
