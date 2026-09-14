# Invitation and sign-in end-to-end run — findings (2026-09-13)

Live run against production (`app.nessie.works`, `api.nessie.works`,
`authentication.unlikeotherai.com`) with two fresh mailboxes on the shared
Stalwart server, `nessie-test-a@unlikeotherai.com` (A) and
`nessie-test-b@unlikeotherai.com` (B), driven headlessly with Playwright. Mail
was read over IMAP. Nothing in the owner's own organisation was touched.

What was exercised, in order:

1. A registers through the public "Create an account" door, verifies by mail,
   sets a password, and creates its first organisation from the UOA chooser.
2. A creates further teams from Nessie's "Add team" dialog (Beta, Gamma).
3. A sends a **team-level** invitation to B (Members → Invite to workspace).
4. B (brand-new address) clicks the mail, registers, lands on "Invitation
   accepted", signs in, sees exactly one team.
5. A sends an **organisation-level** invitation to B choosing a workspace.
6. B (existing account) clicks the mail; the invitation is consumed on landing.
7. A invites, then **revokes**; the revoked link answers "Invitation invalid".
8. Duplicate invitation to the same address collapses to one row; **resend**
   invalidates the earlier link; **decline** from the mail works.
9. B accepts a pending invitation **in-app** from the team switcher.
10. B creates a second organisation ("Bravo Org") and invites A into it —
    both at organisation level and, later, at team level.
11. A signs in again: the UOA chooser shows both organisations and the
    invitation; A accepts it there and sees both organisations in Nessie.
12. "Existing user" add path (no invitation) from B's second organisation.

Everything in that list works. The defects below are what did not.

## Defects

Severity: **P1** blocks or hides membership; **P2** wrong or misleading
outcome; **P3** polish.

### F1 — P1 — A cross-organisation invitation is invisible inside Nessie (Nessie + UOA)

B's organisation "Bravo Org" invited A (who is signed in under organisation
"Alpha Team"). After a **fresh** sign-in, `GET /api/auth/me` for A answered
`uoaPendingInvites: []` while the UOA chooser on the very same sign-in showed
"You've been invited to Bravo Three". Nessie's switcher, bell and `/alerts`
page therefore never offer it; the only ways to accept are the mail link or
the UOA chooser at sign-in time.

Evidence: scratchpad capture `s30-a-capture-me` — two `200` answers of
`/api/auth/me`, both with `invites: []`, `uoaTeams` listing teams of both
organisations. Same-organisation invitations *do* appear (B saw "Gamma Team"
under INVITATIONS in the switcher after a re-login).

Where to look:

- UOA `API/src/services/team-directory.service.ts` `buildSidebarPendingInvites`
  filters `org: { domain }` while `buildSidebarTeams` goes through
  `resolveProductTeamPolicy`; the chooser (`buildSessionChoices`) evidently
  spans both organisations. Confirm what `/org/me` actually returns for A
  (integration test with two organisations on one domain, one invitation
  pending in the org the token is **not** scoped to).
- Nessie `api/src/services/team-invite-alerts.ts` stamps every alert with the
  *active* organisation id and `docs/standards/user-alerts.md` says
  team-invitation alerts "follow the user's current local organisation" — a
  cross-organisation invitation would be filed under the wrong organisation
  even once UOA returns it. The switcher (`TeamMenu.tsx` INVITATIONS section)
  and `AlertRow` show a team name only; with two organisations both named
  "General" the row must name the organisation.

Fix direction: UOA returns every actionable invitation for the address across
the organisations the product policy covers, with `orgName`; Nessie parses
`orgName`, files the alert under the invitation's organisation (or none),
renders "<team> · <organisation>" in switcher/bell/alerts, and acceptance via
`POST /api/team/invitations/:inviteId/accept` switches into the accepted
organisation. Regression tests on both sides.

**Resolution (Nessie side).** `orgName` is parsed as an optional field in
`api/src/services/uoa-team-directory.ts` and carried on
`UoaPendingTeamInviteSchema` / `TeamInvitationAlertMetadataSchema`
(`packages/schemas/src/identity.ts`, `packages/schemas/src/alert-records.ts`),
so `/api/auth/me` and every alert row expose it. The alert keeps being filed
under the recipient's *current* local organisation
(`api/src/services/team-invite-alerts.ts`) — filing it under the inviting
organisation would fail `visibleUserAlertWhere`'s membership clause and hide it
for good — and `docs/standards/user-alerts.md` now states that rule and where
the invitation's own organisation lives instead. The switcher
(`admin/src/layouts/admin-shell/TeamMenu.tsx`), bell and `/alerts`
(`admin/src/components/shared/AlertRow.tsx`) render "<team> · <organisation>"
through one helper, `admin/src/lib/team-invitation-label.ts`. The accept route
(`api/src/routes/team-invitations.ts` → `acceptTeamInvitation`) was verified to
address UOA purely from the posted `organizationId`/`teamId`, with no subject
assertion pinned to the active organisation, and the client already switches
into the accepted organisation via `switchUoaTeam`
(`admin/src/facades/team/invitations.ts`) — neither needed a change. Tests:
`api/test/uoa-directory-refresh.test.ts`, `api/test/auth-uoa-directory.test.ts`,
`admin/test/team-invitation-label.test.ts`.

### F2 — P1 — Membership and invitation changes are stale for up to 30 minutes (Nessie)

B accepted the organisation-level invitation into "General" through the mail
link. B's already-open Nessie session kept showing only "Beta Team" in the
switcher — after a full page reload too — until a sign-out/sign-in. Likewise
the pending "Gamma Team" invitation was not shown to B in-app for several
minutes after A created it; only a re-login surfaced it.

Cause: `api/src/services/uoa-directory-cache.ts` `DIRECTORY_TTL_MS = 30 min`
per user; `/api/auth/me` serves the cached directory and nothing refreshes it
on page load. In-app acceptance does refresh (it rewrites the cache), but any
out-of-band change (mail link, another product, another admin's action) is
hidden for the TTL.

Fix direction: refresh the directory from UOA on `GET /api/auth/me` when the
cached copy is older than a short bound (≈1 min) or when the client asks
(`?refresh=1` from the switcher open / reload), keeping the 30-minute copy as
the fallback when UOA is unavailable. Keep the "verified read reconciles
alerts" rule from `docs/standards/user-alerts.md`. Test: cache older than the
bound → one UOA read; UOA down → cached answer, no alert reconciliation.

**Resolution.** `DIRECTORY_FRESH_MS` (60 s) sits beside `DIRECTORY_TTL_MS` in
`api/src/services/uoa-directory-cache.ts`, which also records when each copy was
verified. `api/src/services/uoa-directory-refresh.ts` re-reads `/org/me` for a
copy older than that — with the same short-lived subject assertion every other
on-demand `/org/*` read uses, through the same payload parser as the login read
— then rewrites the cache and reconciles alerts. A failed read keeps the cached
copy and reconciles nothing, and one in-flight read per user collapses the burst
of `/api/auth/me` calls a page load fires. `buildMeResponse`
(`api/src/services/auth.ts`) calls it before answering. No `?refresh=1`
parameter was needed: the admin simply re-reads `me` when the switcher opens
(`admin/src/layouts/admin-shell/TeamSwitcher.tsx`), and the server decides
whether that costs a UOA read. Tests:
`api/test/uoa-directory-refresh.test.ts`, `api/test/auth-uoa-directory.test.ts`.

### F3 — P2 — First sign-in chooser names the organisation after the "Team name" field (UOA)

The first-login form says "Choose a team — This creates an organisation and
its first team" with one input labelled **Team name**. Typing "Alpha Team"
produced an organisation called "Alpha Team" and a team called "General".
Nessie then shows "General / Alpha Team" everywhere. Label and outcome
disagree.

Where: `Auth/src/i18n/translations/en.ts` `team.createOrg.*`,
`Auth/src/pages/TeamChooserPage.tsx`, route
`API/src/routes/auth/auth-create-organisation.ts` (first team hard-coded to
"General" via `org-placement.service.ts` `DEFAULT_TEAM_NAME`).

Fix direction: ask for the organisation name (label "Organisation name",
helper "Your first team will be called General; you can rename it later"), or
name the first team after the input as well. Update the chooser test.

### F4 — P2 — Chooser invitation card and team list do not name the organisation or the inviter (UOA)

With one organisation the chooser lists teams without organisation names and
the invitation card reads only "You've been invited to General" — no
organisation, no "Invited by". With two organisations the list gains
ALPHA TEAM / BRAVO ORG headings but the card still lacks both. Two
organisations both owning a "General" team make the card ambiguous.

Where: `Auth/src/components/team/InviteCard.tsx`, `TeamChooserPage.tsx`;
`SidebarPendingInvite` / chooser payload should carry `orgName` and the
inviter's name (the `TeamInvite` row has `invitedByName`).

### F5 — P2 — Invitation mail and terminal pages have no way back into the product (Nessie + UOA)

The invitation mail link carries no `redirect_url`; after registering, the
invitee ends on "Invitation accepted — You can close this window", and an
existing account ends on "…close this window and sign in", with **no link**
on either page. The invitee has to know the product URL.

Where: Nessie never passes `redirectUrl` when creating or resending an
invitation (`packages/team-admin/src/uoa-org-roster-pages.ts` create body,
`uoa-org-roster-invitations.ts` resend); UOA `team-invite-page.service.ts`
and `email-registration-link.ts` render terminal pages without a continue
link even when a redirect URL is known.

Fix direction: Nessie sends `redirectUrl: <NESSIE_ADMIN_PUBLIC_URL>/login`
(already in the config's `redirect_urls`); UOA renders "Continue to
<product>" (logo/name from the config JWT `ui_theme.logo.alt`) on both
terminal pages when `redirect_url` is present, and the mail's plain-text part
mentions where to sign in. Keep the no-redirect behaviour unchanged.

**Resolution (Nessie half):** `createTeamInvitation`
(`packages/team-admin/src/uoa-org-roster-pages.ts`) and
`resendTeamInvitation` (`uoa-org-roster.ts`, plus the legacy pair in
`uoa-org-roster-invitations.ts`) now send `redirectUrl` from
`invitationRedirectUrl` (`uoa-org-request.ts`, i.e. `UOA_REDIRECT_URL`) at
both scopes; covered by `api/test/uoa-invitation-redirect-url.test.ts` and
documented in `docs/deployment/sso.md` and `docs/functionality.md`. The UOA
half (a "Continue to <product>" link on the terminal pages) is unchanged.

### F6 — P2 — People who register by e-mail appear as "Unnamed member" (Nessie + UOA)

Neither the public sign-up nor the invitation registration asks for a name,
so the roster shows "Unnamed member" for A in every organisation and team
list, and `AgentOwnerCell` does the same. B shows as "Test B" only because
the inviter typed a name.

Where: Nessie `admin/src/components/features/settings/MembersRosterPanel.tsx:67`,
`MemberInvitationDialog.tsx:188`, `admin/src/components/features/agents/AgentOwnerCell.tsx:46`
fall back to the literal; `docs/deployment/sso.md` promises a humanised
e-mail local part. UOA `Auth/src/components/form/InviteRegistrationForm.tsx`
and the set-password page have no name field.

Fix direction: Nessie falls back to the humanised local part of the e-mail
(`nessie-test-a` → "Nessie Test A") wherever a display name is missing, in
one shared helper; UOA adds an optional "Your name" field to invitation
registration and set-password (stored as the user's name, backfilled from
`inviteName` only when blank, which acceptance already does).

**Resolution (Nessie half):** `admin/src/lib/member-display-name.ts`
humanises the address at render time (nothing is stored — UOA owns
identity), used by `MembersRosterPanel.tsx`, `MemberInvitationDialog.tsx`,
`MemberDetailsDialog.tsx`, `MemberInvitationDetailsDialog.tsx`,
`AgentOwnerCell.tsx`, `AgentOwnershipState.tsx` and
`pages/settings/TeamMemberPeople.tsx`; covered by
`admin/test/member-display-name.test.ts`, and `docs/deployment/sso.md` now
describes the display fallback rather than a stored name. The UOA half (an
optional "Your name" field at registration) is unchanged.

### F7 — P3 — "Add team" opens a dialog titled "Create an organisation" (Nessie)

The switcher's "+ Add team" opens a dialog whose title is "Create an
organisation" with tabs "New organisation" / "In <org>", defaulting to the
new-organisation tab; for a plain member of the organisation the dialog offers
*only* creating a new organisation. The door says "team", the room says
"organisation".

Where: `admin/src/layouts/admin-shell/TeamMenu.tsx` "Add team" → the
create dialog under `admin/src/components/features/team/`. Default to the
"In <org>" tab when the person may create a team there; title the dialog
"Create a team" and rename the tab pair to "In <org>" / "New organisation".

**Resolution:** `admin/src/layouts/admin-shell/CreateTeamDialog.tsx`
defaults to the team tab (and so to the title "Create a team") for anybody
who may create a team here, keeping the organisation tab and its copy; a
person who may not still gets the organisation form, titled "Create an
organisation". Covered by `admin/test/create-team-dialog-scope.test.ts`.

### F8 — P3 — Legacy team-invite form posts a body the route no longer accepts (Nessie)

`admin/src/pages/settings/TeamMembersSection.tsx` (non-UOA sessions only)
still posts `{invites:[{email, teamRole}]}` through
`admin/src/facades/users/team-members.ts:80` to `POST /api/team/invitations`,
which validates the single-invite `CreateMemberInvitationRequestSchema`
(`api/src/routes/team-members.ts:387`). Unreachable in production; either
align the body or delete the legacy branch.

**Resolution:** `admin/src/facades/users/team-members.ts` exposes
`useCreateTeamInvitation`, posting the single-invite
`CreateMemberInvitationRequest` body the route validates;
`admin/src/pages/settings/TeamMembersSection.tsx` sends its one address that
way and no longer relays a per-address verdict the route does not return.
Covered by `admin/test/team-invite-legacy-form.test.ts`.

## Verified working (no change needed)

- Public sign-up → "Your sign-in link" mail (≈5 s) → set password → chooser.
- Team-level and organisation-level invitations, the workspace picker at
  organisation level (`teamId` travels on create, resend, revoke), pending
  lists at both scopes, member details with team-access checkboxes.
- New-address landing → "Create your account" (e-mail read-only) → "Invitation
  accepted"; existing-address landing consumes the invitation on the spot.
- Revoke → link answers "Invitation invalid"; resend → earlier link invalid;
  decline → "Invitation declined" and the row vanishes at both scopes;
  duplicate submit → one pending row (upstream resend).
- In-app accept from switcher and bell; alert deleted on acceptance.
- Non-admin member: organisation Members page correctly gated
  ("Organisation administrator access is required."); team roster hides
  e-mail addresses from non-managers.
- Second organisation creation from Nessie, cross-organisation acceptance
  through the UOA chooser, switcher listing teams of both organisations with
  organisation subtitles, "Existing user" add path.
- Stalwart subaddressing (`user+tag@`) delivers, useful for further runs.

## Test fixtures left in place

Mailboxes `nessie-test-a@` / `nessie-test-b@unlikeotherai.com` (Stalwart ids
`f`, `g`) and their UOA accounts owning organisations "Alpha Team" (teams
General, Beta Team, Gamma Team) and "Bravo Org" (General, Bravo Two, Bravo
Three). Delete when no longer needed.
