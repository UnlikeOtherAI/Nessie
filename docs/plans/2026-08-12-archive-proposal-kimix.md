# Proposal: Archive / unarchive across Nessie — one lifecycle, one surface

**Model in one paragraph.** Archive is a single, org-wide lifecycle state — not
per-object-type, not cold storage with different rules per screen. Every
archivable thing (project, team, channel, thread, task, knowledge page) carries
the same `archivedAt` semantics: hidden from active listings, read-only when
opened, restorable by anyone entitled to manage it. The channel model — Archive
in the object's own settings dialog plus an Archived list with an Unarchive
button — is the reference, and projects are brought into line with it exactly,
including permissions: disposal decisions belong to the people who manage the
object (project/team/channel admins and owners, and org admins), not to the org
owner alone. Delete becomes honest: it means "archive now, purge permanently
after a 30-day retention window" — the same promise on every object — and the
permanent purge is owner-only, type-name-to-confirm, cancellable until the date
passes. Archiving a parent never mutates its children's state; it hides the
whole subtree behind the parent, and unarchiving restores exactly the state
that existed before, including any children that were individually archived.
One org-wide `/archive` surface owns the whole lifecycle; every scope that can
produce archived items gets a small in-context doorway ("3 archived channels")
that links into it.

## 1. The mental model

**One concept, one surface, many doorways.** Archive is a lifecycle state, not
a storage tier and not per-type. The admin learns it once — "archive hides it,
everything inside is safe, you can bring it back" — and it behaves identically
whether the object is a project or a thread. That uniformity is what the owner
asked for ("we need to make the system consistent") and it is the cheapest
model to keep honest, because there is exactly one Archive page to keep true.

**The cascade rule: archive the container, not the contents.** Archiving a
project sets `Project.archivedAt` and *nothing else*. Its teams, channels,
threads and tasks keep their own flags untouched; they simply become
unreachable through the hidden parent, exactly as if the project were a closed
folder. Unarchiving the project restores the previous world precisely: a
channel that was individually archived before stays archived; everything else
comes back active. The alternatives lose:

- *State cascade* (set `archivedAt` on every descendant) makes unarchive
  ambiguous — "restore everything" resurrects channels someone deliberately
  archived; "restore only what changed" requires provenance bookkeeping we do
  not need.
- *Block on non-empty* (today's delete behaviour) is a deletion affordance, not
  an archival one. Reversibility removes the reason to demand an empty
  container.

**Read-only while archived.** An archived object, and anything inside an
archived ancestor, renders its history but accepts no writes: no messages, no
task moves, no new runs, no edits. Unarchive restores full behaviour. This is
one rule the UI states in one banner component reused everywhere.

## 2. Where archiving is initiated

The pattern is: **danger zone in the object's own settings surface, plus a
contextual row affordance where one exists.** Confirm is a modal for
containers, a two-step button for threads/tasks, and a toast with Undo is *not*
used — archive is already undoable by design, so the confirm modal states
"You can restore it later from the Archive page" and that is the undo story.

| Level | In-context entry point | Owning settings surface |
|---|---|---|
| Organisation | Not archivable in-product (see §10) | — |
| Project | `/projects/:id/settings` → new **Archive / Delete** danger zone below Columns | Project settings page |
| Team | Team row in project settings (v2) | — |
| Channel | Channel sidebar row ⋯ menu → Settings opens `ChannelSettingsDialog` (existing) | Channel settings dialog (existing) |
| Thread | Thread header ⋯ menu → "Archive thread" (non-default threads only) | — |
| Task | `ArchiveDoneMenu` (existing, keep) + card ⋯ "Archive" | Board Done column (existing) |
| Knowledge page | Page ⋯ menu → "Archive" (status already exists server-side) | — |
| Agent / trigger / workflow | Row ⋯ menu → "Archive" alongside existing disable/delete (v2) | — |

**In-context entry-point wireframe — project settings danger zone:**

```
┌─ /projects/:id/settings ─────────────────────────────────────────────┐
│  Board style   [Kanban] [Iterations]                                  │
│  Columns       … existing column editor …                             │
│ ────────────────────────────────────────────────────────────────────  │
│  DANGER ZONE                                                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Archive project                                                │  │
│  │ Hides "Atlas" and everything in it. Read-only. You can restore │  │
│  │ it any time from the Archive page.          [ Archive… ]       │  │
│  │                                                                │  │
│  │ Delete project                                                 │  │
│  │ Archives it now and deletes it permanently after 30 days.      │  │
│  │ Owners can cancel before then.               [ Delete… ]       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

Archive confirm modal copy (channel today, same shape everywhere):
"Archive **Atlas**? It becomes read-only and hidden from the sidebar. All its
teams, channels and history are kept, and you can restore it any time from the
Archive page." `[Cancel] [Archive]` — primary button, not danger-styled,
because archiving is safe. Delete gets the danger style and its own modal:
"Delete **Atlas**? It is archived immediately and **deleted permanently on 12
September 2026**. Until then, an owner can keep it from the Archive page."
`[Cancel] [Archive & schedule deletion]` — the button names what it does.

## 3. Where archived things live

**One owning surface: `/archive`**, a top-level route in the Admin section of
the sidebar (`AdminSidebarNav`, "Organization" group, labelled **Archive**),
using the existing `SettingsPanel` frame so it reads as part of the admin
family. It is scoped by entitlement, never by session context: the API returns
every archived item the caller is entitled to restore (their manageable
projects, teams, channels) plus read-only visibility into items they belong to
but cannot restore.

**Per-scope doorways into it** (Rule zero's second entry point):

- Sidebar channel list footer row: "3 archived channels →" linking to
  `/archive?type=channel` (only rendered when the count is non-zero).
- Project picker/sidebar footer: "1 archived project →".
- The separate Settings → Channels page and route are removed. The main
  Channels surface owns channel creation, settings, and archive actions; no
  second channel-management implementation survives (Rule zero #4).

**Main surface wireframe:**

```
┌─ Admin / Archive ──────────────────────────────────── [⌕ Search…] ──┐
│ Tabs: All (9) · Projects (1) · Channels (3) · Threads (2) · Tasks (3)│
│ ──────────────────────────────────────────────────────────────────── │
│ ▣ Atlas                                    Project · by Dana, 3 Aug  │
│   2 teams · 5 channels · restores with all contents                  │
│   Scheduled for permanent deletion 12 Sep   [Keep] [Restore]         │
│ ──────────────────────────────────────────────────────────────────── │
│ ▣ #design-crit        Channel · Atlas / Product · by Sam, 30 Jul     │
│   412 messages · last activity 28 Jul                [Restore]       │
│ ▣ #legacy-import      Channel · Atlas / Product · scheduled 9 Sep    │
│   Permanently deleted in 28 days            [Keep] [Delete now]      │
│ ──────────────────────────────────────────────────────────────────── │
│ ▣ "Vendor shortlist"  Thread · #research · by you, 21 Jul  [Restore] │
│                                                                      │
│ … Tasks section shows title, project, column, archived date …        │
└───────────────────────────────────────────────────────────────────────┘
```

Every row answers a decision: *what is this, where did it live, who archived
it and when, is it on a deletion clock, and can I bring it back?* Restore is
shown only when the caller is entitled (no buttons that 403); "Keep" cancels a
scheduled purge (owner-only); "Delete now" is owner-only, type-name-to-confirm.
Finding a channel three months later: the page's search box filters across all
tabs by name (v1); global `/search` gains an "Include archived" toggle (server
dependency, v2).

## 4. What an archived thing looks like when you're in it

Deep links keep working — archived does not mean 404. A single reused
component, `ArchivedBanner`, renders at the top of the channel view, project
board, docs tab and knowledge page:

> **This channel is archived — read only.** Archived by Sam on 30 Jul.
> `[Restore]` *(if entitled)* · "Go to Archive page" link.

The composer is disabled with the banner as the explanation; board cards don't
drag; no new agent runs start (server rejects run creation in archived
channels; queued/running work is allowed to finish — killing in-flight runs is
a separate ops concern). Today nothing in the channel pages checks
`archivedAt`, so an archived channel is fully writable via deep link — this
banner plus the server write-guard fixes that defect as part of this work.

## 5. Navigation & counts

Archived items **disappear from active lists entirely** — no greying out, no
collapsed rows. The only residue is the count-chip doorways in §3, each of
which exists to drive one decision ("is the thing I'm looking for archived?").
Sidebar projects section, channel section, project board selectors all filter
`archivedAt == null`, matching the existing channel-list behaviour.

## 6. The relationship to delete — option (c), applied everywhere

I pick **(c): Delete = archive now + purge after 30 days, dated and
reversible-until-it-isn't**, and it applies identically to channels, projects,
teams and threads. The defect — two labels, one archive mutation, a
danger-styled "Confirm delete" that destroys nothing — is resolved by making
Delete *finally mean something different from Archive*:

- **Archive** → `archivedAt = now`. Reversible forever. Primary-styled.
- **Delete** → `archivedAt = now`, `deleteRequestedAt = now`; purge eligible at
  `deleteRequestedAt + 30 days`. Danger-styled. The dialog copy states the
  exact date.
- **Purge** (hard delete) happens from the Archive page only, org **owner
  only**, either by "Delete now" with type-name-to-confirm or by a nightly
  sweep of expired rows. "Keep" clears `deleteRequestedAt` and leaves the item
  archived.

This is the honest reading of what the UI already promises and what the owner
wants ("we can delete projects, but make sure we have the right permissions").
Option (a) — instant hard delete from a settings dialog — is irreversible from
a two-click modal; too sharp a tool next to "Save". Option (b) — removing
Delete — makes "Archive" the only disposal verb and leaves no answer to
genuine deletion needs (test projects, imported junk, GDPR-adjacent cleanup).
Channel `DELETE /api/channels/:id` stays as an alias for archive (its current
documented behaviour); the *new* capability is purge, gated to owners, from the
Archive surface where the dated promise is visible. For projects, the current
empty-check hard delete is **replaced** by this flow — archive needs no
non-empty guard because nothing is destroyed, and purge of a non-empty project
purges its subtree in one transaction (the 30-day window is the safeguard the
`PROJECT_NOT_EMPTY` 409 was approximating).

## 7. Permission matrix — what changes and why

Today's asymmetry (team admin can dispose of a channel; only org owner can
dispose of a project) is wrong for a tool where projects are the primary
organising unit. Disposal follows **manageability at the object's own level,
mirroring `canManageChannel`**, with permanent destruction reserved for the org
owner:

| Level | Archive / Unarchive | Schedule deletion | Purge / Keep |
|---|---|---|---|
| Project | project `owner`/`admin`, or org `owner`/`admin` | same as archive | org `owner` only |
| Team | team `owner`/`admin`, project `owner`/`admin`, org `owner`/`admin` | same | org `owner` |
| Channel | *(unchanged)* channel/team/org `owner`/`admin` | same as archive | org `owner` |
| Thread | channel `owner`/`admin` (or message-owning manager roles); default "General" thread is not archivable | n/a — threads purge with their channel | org `owner` |
| Task / knowledge / agent / trigger / workflow | keep each type's existing manage rule | same | org `owner` |

Rules being changed: (1) project disposal moves from org-owner-only to
project-admin-or-above — the same shape `canManageChannel` already encodes,
via a new `canManageProject` service helper; (2) permanent deletion anywhere
becomes org-owner-only rather than an unlabelled synonym for archive; (3)
everything else is additive. Rule zero scoping: the Archive page and banners
render Restore/Keep/Delete-now only for entitled callers; members who can see
but not manage an archived item get the read-only banner without actions.

**Empty / denied states.** Archive page with nothing archived: "Nothing is
archived. Archived channels, projects and threads land here, restorable." A
member with no manage rights anywhere still sees the page (they may need to
*find* something) but sees zero action buttons. A caller hitting a deep link to
an archived project they're a member of sees the read-only view; a non-member
gets the existing 404/403-indistinguishable treatment, consistent with
`CHANNEL_FORBIDDEN`'s deliberate opacity.

## 8. Migration of what exists

- `ChannelSettingsDialog`: keep; **fix `handleDelete`** to schedule deletion
  (new mutation) instead of calling archive, and update its confirm copy to
  state the date. Archive path untouched.
- Settings → Channels: remove the page, route, and navigation item. The main
  Channels surface is the sole owner of channel creation, settings, and archive
  actions.
- `ArchiveDoneMenu`: keep as-is — it is prior art this proposal copies (small,
  in-context, low-ceremony).
- Channel `DELETE` endpoint: keep, documented as soft-archive alias.

## 9. Minimum first slice (one week)

1. `Project.archivedAt` + `deleteRequestedAt`, `Channel.deleteRequestedAt`
   (migration); archive/unarchive endpoints + `?includeArchived` on projects
   list; `canManageProject` helper; server write-guard on archived channels
   (no messages, no runs).
2. `/archive` page with Projects + Channels tabs only (the two types that have
   server support), entitlement-scoped, Restore + Keep + Delete-now (owner).
3. Project settings danger zone; fixed `ChannelSettingsDialog` Delete;
   `ArchivedBanner` on channel view + project tabs; sidebar doorways.
4. Purge is manual ("Delete now") this week; the nightly expiry sweep lands
   right after.

This satisfies Rule zero: projects get the channel model end-to-end with an
owning surface and in-context entry points in the same change. Teams, threads,
knowledge, agents/triggers/workflows and the global-search toggle are the
second slice, each reusing the same page, banner and permission shape.

## 10. Where the model deliberately does not go

**Organisation is not archivable in-product.** An org is the tenancy boundary;
archiving it from inside itself strands everyone with no surface left to
unarchive from (the Archive page lives inside the org). Org teardown stays an
out-of-band owner/support operation. This is stated so nobody files it as a
gap later.

## Server-side dependencies (brief)

- Schema: `Project.archivedAt`, `Project.deleteRequestedAt`,
  `Team.archivedAt`, `Thread.archivedAt`, `Channel.deleteRequestedAt`
  (all nullable `DateTime`, one migration).
- Endpoints: `POST /api/projects/:id/archive|unarchive`,
  `GET /api/projects?includeArchived`, same pair for teams and threads;
  `POST /api/:type/:id/delete` (schedules purge) and
  `POST /api/:type/:id/purge|keep` (owner-only).
- List filters: `includeArchived` on every list endpoint the doorways query;
  archived-scope counts for sidebar chips.
- RBAC: new `canManageProject` helper mirroring `canManageChannel`; purge
  gated on org owner; failure codes follow the existing opaque-403 convention.
- Write guards: reject message/run/task mutations in archived channels,
  threads, or archived ancestors.
- Jobs: nightly purge sweep of expired `deleteRequestedAt` rows; audit events
  `*.archived`, `*.unarchived`, `*.deletion_scheduled`, `*.purged`.
- Search (v2): `includeArchived` flag on the global search endpoint.
