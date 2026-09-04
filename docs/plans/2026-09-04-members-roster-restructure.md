# Members roster restructure

Status: implemented for UOA-backed organisation and team settings (2026-09-04).

Review: Codex Sol reviewed the first draft on 2026-09-04 and returned a
no-go. This revision incorporates its findings. The required UOA contract work
landed first; this document records the implemented UOA path and the deliberate
local-mode boundary.

## Outcome

`/settings/members` (organisation) and `/settings/team/members` (team) become
two homes for one reusable, full-width `MembersRoster`. They share the table,
the URL-backed state tabs and the standard cursor pagination contract, while a
scope adapter supplies only data, row actions and invitation choices.

The three requested tabs are deliberately defined as follows:

- **Active**: active organisation memberships on the organisation surface;
  active memberships in the selected team on the team surface.
- **Pending invitations**: actionable email invitations. On the organisation
  surface this means all actionable invitations in the organisation, with an
  explicit optional team filter; on the team surface it means that team only.
- **Deactivated**: `DEACTIVATED` organisation memberships on the organisation
  surface; `DEACTIVATED` memberships of the selected team on the team
  surface.

`REMOVED` is not labelled Deactivated and is not shown as a fourth tab: it is
historical team membership, not an inactive person. A manager can add an
otherwise active removed person back through the team dialog's Existing user
tab. The removal action therefore returns to the Active tab rather than
claiming a result appears in Deactivated.

The page-header primary action is **Send invitation** in UOA-enabled installs.
Local/no-IdP installs retain their authoritative existing member management
until a local roster migration is designed; they must not pretend an email
invitation exists. This change does not replace local identity authority with
UOA-style flows.

The UOA roster pages replace their old card grids, person-agent nesting and
unassigned-agent buckets: they do not drive a membership decision and do not
belong inside a people table. The no-IdP surface remains a separate migration.

## Surface and interaction design

1. Create one `MembersRoster` feature with `organization` and `team` scope
   adapters. The existing settings routes and `SettingsPanel` headers remain
   the doorways; no duplicate team and organisation table implementations are
   introduced.
2. Use the shared `TabBar` and a replace-only URL parameter for the three page tabs. The
   selected state is a replace-only URL parameter, so refreshes and shared
   links preserve it without Back-stack noise. The invite dialog's two team
   choices are local dialog state, not page URL state.
3. Render every tab with `DataTable` plus `PaginationFooter`, never a card
   list. Rows use the shared identity primitive. Narrow layouts fold secondary
   facts into the user cell rather than silently discard them.
4. Member rows show the UOA-authorized identity fields and role for the selected
   scope. Email is not assumed to be universally visible: UOA makes the
   disclosure decision and omits it when the reader lacks the permission.
   Role/lifecycle/removal controls remain out of this first table because UOA
   roles are configurable and no authoritative option vocabulary is yet in the
   roster contract; the live capability response is retained for that follow-up.
5. Pending-invitation rows show recipient, target team where relevant and
   expiry. They use the same server pagination as member rows; the UI never
   loads an unbounded history then slices it in the browser.
7. **Send invitation** opens the shared `Dialog` in the header action.
   - In organisation scope, the dialog first requires an explicit target-team
     selection from teams the actor may invite into, then collects the email.
     It never silently uses the session's active team.
   - In team scope, the dialog has two internal `TabBar` panels. **Existing
     user** is a debounced, server-side name/email autocomplete of eligible
     active organisation members and directly adds the selected UOA subject to
     this team. **Invite to workspace** sends the email invitation. The default
     UOA team role is used until UOA exposes the configured role vocabulary.
   - Success closes the dialog, invalidates the scope's paged query family
     and selects the tab that honestly contains the result. Validation and
     upstream refusal remain inline in the dialog.

## Data, authority and authorization

UOA remains the sole authority for identity, organisation/team membership,
roles, invitations and lifecycle. Nessie persists no roster/profile mirror
and does not assemble a roster by intersecting UOA's domain-wide user list.
That list is capped, crosses product/organisation boundaries and is not an
acceptable source for either the table or autocomplete.

Each UOA-backed response must carry both the minimal identity data that the
caller is entitled to receive and action-specific capability verdicts. Nessie
does not derive a generic `canManage` flag from its local role cache. The
required distinctions include at least:

- read roster and invitation/contact data;
- invite to the particular team;
- add, re-role and remove team members;
- change an organisation role;
- deactivate and reactivate an organisation member.

The API relays the actor's UOA subject assertion on every read and mutation.
It re-reads authoritative state after a mutation, and its facades invalidate
only the relevant filtered/paged query family. A viewer receives neither
candidate autocomplete identities nor invitation emails unless UOA grants the
appropriate capability.

## Pagination contract

This is a standard admin list, not a process-local cache over a forward-only
upstream feed. Every roster, candidate search and invitation endpoint must
support this contract end to end:

- request: `cursor`, `limit` (default 25, maximum 100) and
  `direction=forward|backward`;
- response: `{ data, meta: { nextCursor, prevCursor, total, hasMore } }`;
- opaque stateless keyset cursors, stable for a shared/reloaded URL and valid
  across Nessie instances;
- a count for the same organisation/team/status/filter on which the page is
  based.

Nessie will repair `usePagedList` to transmit `direction` and use the shared
server pagination helper rather than hand-building metadata. A cursor cache is
not a substitute: it would expire on another instance, after a refresh or
after UOA revocation. Browser-side slicing is prohibited for these unbounded
lists.

## Required UOA contract work (completed)

The following has to land in UnlikeOtherAuthenticator before Nessie implements
the UOA-backed UI. These are product/API changes in a separate repository, not
changes Nessie can safely fake.

1. **Organisation roster and candidate search.** Add organisation-scoped,
   paged member listing and candidate search that return a stable UOA subject,
   authorized display identity and role/status. Candidate search accepts a
   bounded name/email query and returns only people eligible to be added to
   the target team. Define email disclosure explicitly rather than relying on
   the domain-wide `/domain/users` endpoint.
2. **Team member states.** Add a paged team-members endpoint supporting
   `ACTIVE`, `DEACTIVATED`, `REMOVED` and `all`, with the member's stable UOA
   subject and authorized identity. UOA's present team detail contains active
   memberships only, so Nessie cannot otherwise truthfully implement the team
   Deactivated tab.
3. **Action capabilities.** Return or expose scoped, live capability verdicts
   for each member/invitation operation above. Organisation role change,
   organisation lifecycle and team management must remain different decisions;
   configurable UOA roles cannot be reduced to Nessie's `admin|member` guess.
4. **Organisation invitation authority.** Add a paged organisation-wide
   actionable-invitations feed with target-team identity and an explicit,
   authorized target-team selector for invitation creation. It must not bind
   an organisation page to whatever team happens to be in the session claim.
   The current organisation approval queue is not an actionable-invitation
   history and is not a replacement.
5. **Stateless standard pagination.** Make roster, candidate and invitation
   endpoints use bidirectional opaque keyset cursors and filtered totals. The
   current forward-only organisation roster and unpaged team invite history
   cannot meet Nessie's standard pagination contract at scale.

The UOA work must retain the distinction between `DEACTIVATED` (an
organisation-wide lifecycle that deactivates/restores all active team
memberships) and `REMOVED` (a team membership history state). Nessie will not
rename one as the other.

## Nessie implementation after the contracts landed

1. Extend `@nessie/schemas` with the common paged roster, invitation,
   capability and candidate shapes. Implement UOA relay services/routes with
   strict query validation and no local profile/membership fallback.
2. Keep local-mode adapters and member creation out of the UOA change. A later
   migration may adopt the common table/pagination composition, but must not
   add a local email-invite system under this change.
3. Build `MembersRoster`, scope adapters, member/invitation row definitions,
   `DataTable` layout, URL tabs and standard footer. Delete the old duplicated
   card sections only after both route doorways render the replacement.
4. Build the shared invite dialog, including the explicit organisation team
   picker and the team Existing user / Invite to workspace panels. Reuse the
   navigation dialog shell and primitive controls.
5. Add per-action visibility, accessible labels, query invalidation and
   mutation handling. Update any affected settings/member documentation with
   the final UOA contract and scope semantics.

## Verification and release gate

- UOA contract tests prove no cross-organisation identity enumeration, field
  disclosure rules, capability checks, cursor traversal in both directions,
  correct filtered totals and the `DEACTIVATED`/`REMOVED` distinction.
- Nessie route/facade tests prove subject assertion relaying, explicit
  organisation target-team scope, no local fallback, per-action control gates
  and page invalidation after each mutation.
- Admin tests cover URL tab state, table columns, standard pagination, empty
  states, the organisation team picker and team autocomplete selection.
- Run lint/type tests for all touched packages. Start local servers on 5454
  and 5455, verify health, then use headless Playwright on both member routes
  to exercise every tab and invitation dialog and capture screenshots.

The UOA release gate is satisfied by the companion UOA contract change and the
Nessie relay/UI verification. Local-mode convergence remains separate work.
