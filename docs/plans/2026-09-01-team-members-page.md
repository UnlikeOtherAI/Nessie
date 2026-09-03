# A team-scoped Members page, reusing the org page (plan)

> **Status: blocked on the in-flight Project/Team unification.** A parallel
> effort is actively renaming/restructuring the Project/Team/Workspace
> vocabulary (see `docs/plans/2026-09-02-uoa-as-a-service-unification.md` and
> commit `dc713d9d`) — as of 2026-09-03 the owner has directed that effort to
> land on the word **"Team"** for the UOA-mapped concept, overriding that
> doc's "workspace" proposal, with the exact final shape of Project's
> relationship to Team still being settled. This plan captures the confirmed
> facts and the owner's exact UI spec now, so no requirements are lost, but
> the "currently selected team" resolution and file citations below must be
> re-verified against whatever model actually lands before this is built —
> do not build against this doc's file names without checking they still
> exist.

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

- **Stays team-scoped, unchanged, reused as-is:** `GET /api/workspace/members`
  (`api/src/routes/workspace-members.ts`), `listWorkspaceMembers`
  (`packages/workspace-admin/src/uoa-org-roster.ts`),
  `WorkspaceMembersSection.tsx` / `WorkspaceMemberPeople.tsx`. These were
  already correctly scoped to a single team before the fix — that's exactly
  why the fix left them alone rather than folding them into the new
  org-wide read.
- **New org-scoped pieces the fix added** (will need a `scope` parameter
  when this redesign is actually built, or a sibling set for team scope):
  `listOrganisationMembers` / `updateOrganisationMemberRole` /
  `withUoaOrgRosterSubjectAssertion`
  (`packages/workspace-admin/src/uoa-org-members.ts`),
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

1. **Resolve the parallel rename first.** "Currently selected team"
   resolution, and whether "Project" survives as a concept at all, both
   depend on where `2026-09-02-uoa-as-a-service-unification.md` lands.
   Find and cite the real precedent for active-team resolution in `admin/`
   once that's settled — do not invent a new mechanism.
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
