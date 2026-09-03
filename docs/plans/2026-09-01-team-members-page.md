# A team-scoped Members page, reusing the org page (plan)

> **Status: blocked on the Project/Team unification's structural half; the
> rename half landed 2026-09-03.** The workspace→team vocabulary rename
> shipped on main as commit `4fe11c54` ("refactor: rename the workspace
> concept to team, everywhere", 2026-09-03), landing on the word **"Team"**
> for the UOA-mapped concept as the owner directed that day, overriding
> `docs/plans/2026-09-02-uoa-as-a-service-unification.md`'s "workspace"
> proposal. What it did: `GET /api/workspace/members` → `GET
> /api/team/members` (`api/src/routes/workspace-members.ts` →
> `api/src/routes/team-members.ts`, same for the `/api/workspace/invitations*`
> → `/api/team/invitations*` relays), `listWorkspaceMembers` →
> `listTeamMembers` and `resolveUoaRosterWorkspace` → `resolveUoaRosterTeam`
> (`packages/workspace-admin` → `packages/team-admin`), and
> `WorkspaceMembersSection.tsx` / `WorkspaceMemberPeople.tsx` →
> `TeamMembersSection.tsx` / `TeamMemberPeople.tsx` — the citations in this
> doc are updated to the new names. Still open and blocking this build: the
> structural Project/Team unification the rename deliberately did **not** do
> (sized by commit `dc713d9d`, see the unification doc), including the exact
> final shape of Project's relationship to Team and the real precedent for
> "currently selected team" resolution in `admin/`. This plan captures the
> confirmed facts and the owner's exact UI spec now, so no requirements are
> lost, but do not build against this doc's structural assumptions without
> checking what actually lands.

## Why a team-scoped page is not redundant with the org page

Confirmed fact, verified directly against `../UnlikeOtherAuthenticator`
(`API/src/services/organisation.service.members.ts`, `addOrganisationMember`,
~line 100-208; route `POST /org/organisations/:orgId/members`,
`API/src/routes/org/organisation-members.ts:91`): UOA's admin direct-add
(an existing UOA userId, not an email invite) does three things in one
transaction — (1) finds the org's DEFAULT team, (2) creates the org
membership row, (3) creates a team-membership row for **that one default
team only**. So an org-level grant is org role + the org's single default
team, and **nothing** in any other team. Every other team needs its own
separate invitation or add. This is why "add someone to this team" is a
genuinely different, narrower action than "add someone to the org" — a
team members page has real work to do that the org page cannot.

## The owner's exact UI spec (2026-09-03), captured verbatim

- The page becomes a standard admin data table with standard pagination —
  reuse whatever paginated-table pattern already exists elsewhere in
  `admin/` (find and cite it when this is built; not identified yet).
- Three tabs above the table, mutually exclusive views of the same roster:
  **Pending invitations**, **Active**, **Deactivated**. Use `TabBar`
  (`admin/src/components/primitives/TabBar.tsx`) per CLAUDE.md's "One tab
  bar" rule. On the org scope, "Pending invitations" is necessarily the
  union of pending invites across the org's locally-known teams — UOA has
  no team-less invite (confirmed, see the org-members-page fix landed
  2026-09-03, `docs/plans/2026-08-31-identity-belonging-audit.md` F10 note).
- A single **"Invite"** button, top-right of the page.
- Clicking it opens a dialog (`admin/src/components/shared/Dialog.tsx`, per
  CLAUDE.md's "One dialog shell" rule):
  - **On the org page:** the invite form as it exists after the 2026-09-03
    fix — email + which team the invitee joins. One tab's worth of content,
    no tab strip.
  - **On the team page (this plan's actual subject):** TWO tabs inside the
    dialog:
    1. **"Existing user"** — a name/email autocomplete-as-you-type search
       over people already in the organisation (already hold org
       membership + the org's default team, per the confirmed fact above)
       but not yet in *this* team. Selecting one adds them directly to this
       team — UOA's team-membership add, no email invitation needed, since
       they're already a known UOA org member.
    2. **"Invite"** — the existing email-invite flow, scoped to this team,
       for someone not yet in the org at all.
  - This two-tab dialog is the **only** structural difference between the
    org page and the team page. Table, columns, pagination, the three
    status tabs, and role/deactivate actions are the exact same component
    reused, parameterized by scope.

## Reuse strategy — from the 2026-09-03 org-members-page fix

The fix that shipped 2026-09-03 already drew the scope boundary this plan
depends on:

- **Stays team-scoped, unchanged, reused as-is:** `GET /api/team/members`
  (`api/src/routes/team-members.ts`), `listTeamMembers`
  (`packages/team-admin/src/uoa-org-roster.ts`),
  `TeamMembersSection.tsx` / `TeamMemberPeople.tsx`. These were
  already correctly scoped to a single team before the fix — that's exactly
  why the fix left them alone rather than folding them into the new
  org-wide read. (Renamed from `workspace-members.ts` / `listWorkspaceMembers`
  / `packages/workspace-admin` / `WorkspaceMembersSection.tsx` /
  `WorkspaceMemberPeople.tsx` by the workspace→team rename, commit
  `4fe11c54`, landed the same day as this doc was written — 2026-09-03.)
- **New org-scoped pieces the fix added** (will need a `scope` parameter
  when this redesign is actually built, or a sibling set for team scope):
  `listOrganisationMembers` / `updateOrganisationMemberRole` /
  `withUoaOrgRosterSubjectAssertion`
  (`packages/team-admin/src/uoa-org-members.ts` — the package was
  `packages/workspace-admin` when the fix landed earlier the same day;
  `4fe11c54` moved it),
  `GET/PUT/POST /api/organization/members*`
  (`api/src/routes/organization-members.ts`),
  `OrganizationMembersSection.tsx`, `useOrganizationMembers()` /
  `useUpdateOrganizationMemberRole()`
  (`admin/src/facades/users/organization-members.ts`).
- **Not yet built, needed for the redesign regardless of scope:** the
  paginated table component, the three-tab status view, the invite dialog,
  and (team scope only) the existing-user autocomplete — none of this
  exists today on either the org or team roster surfaces, which currently
  render as plain lists.

## Open items before this can be built

1. **~~Resolve the parallel rename first.~~ RESOLVED 2026-09-03 — the
   workspace→team rename landed as commit `4fe11c54`**, so the word is
   settled: the UOA-mapped concept is "Team", and the roster/members
   machinery lives at `api/src/routes/team-members.ts`,
   `packages/team-admin/src/uoa-org-roster.ts`,
   `TeamMembersSection.tsx` / `TeamMemberPeople.tsx`. What remains open from
   this item is the *structural* half the rename did not touch: whether
   "Project" survives as a concept at all still depends on where
   `2026-09-02-uoa-as-a-service-unification.md` lands, and the real precedent
   for active-team resolution in `admin/` still needs finding and citing —
   do not invent a new mechanism.
2. **Existing-user autocomplete.** No autocomplete/person-picker component
   was identified in `admin/` during the 2026-09-03 work. Confirm whether
   one exists (search `admin/src/components/`) before building a new one.
3. **Doorway (rule zero).** Where a person standing in a team's settings
   finds this page (a Members tab/section on team settings), and how it
   visually relates to/links from the org Members page, needs a concrete
   answer once the team settings surface's final shape is known.
4. **Org-wide pending-invitations union.** Confirm whether merging
   per-team invite lists client-side is acceptable at typical team counts,
   or whether it needs a dedicated relay — not decided.
