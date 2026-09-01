# Archive / unarchive across Nessie — UI proposal (reviewer: Fable)

**Summary.** Archive is one org-wide lifecycle state — a nullable `archivedAt`
stamp per object — with channels as the reference model and projects brought
into line with them, exactly as the owner asked. Archiving is initiated
in-context (the settings dialog or `⋯` menu of the thing itself), archived
items vanish from working navigation into a single owning surface at
`/settings/archive`, and a parent's archive **implicitly freezes** its children
without stamping them, so unarchiving a project restores precisely the state it
had — channels archived on their own stay archived. Delete survives, but it
starts telling the truth: it is a real hard delete, org-owner-only, and only
reachable for something *already archived*. That archive-first gate replaces
both today's lying channel "Delete" button (which silently archives) and the
project `PROJECT_NOT_EMPTY` destroy-children-first dance, and it gives a
cooling-off period without building a retention timer.

## 1. Mental model and the cascade

Archive is a **lifecycle state, not a cold-storage tier and not a soft
delete**: the object keeps its rows, its history, and its identity; it merely
stops accepting new work and leaves working navigation. One concept, one verb
("Archive"), one icon (`faBoxArchive`, already used by `ArchiveDoneMenu`),
applied per object type.

Where it applies, and where it deliberately does not:

- **Project** and **Channel** — the spine. Both get first-class archive
  (`Project.archivedAt` is new; `Channel.archivedAt` exists).
- **Task** — already has `archivedAt` and a working local surface (the Kanban
  "Archived" section + `ArchiveDoneMenu`). Keep it project-local; unify only
  the vocabulary and icon.
- **Knowledge page** — already has `status: archived`. Keep its existing flow;
  it is a document lifecycle, not navigation disposal.
- **Team** — no UI. Teams are plumbing in the admin today (the sidebar renders
  Projects → channels; `teamIdByProjectId` maps one default team per project).
  Teams inherit their project's archive implicitly; a team-level control would
  be a surface nobody can reach, violating Rule zero from the other direction.
- **Thread** — no. Threads inherit their channel and have no management UI to
  hang a control on.
- **Organisation** — no. Disposing of an org on a self-hosted instance is
  deactivation/decommissioning, a different operation with different stakes;
  member deactivation (`OrganizationMember.deactivatedAt`) already exists.
- **Agents, triggers, workflows** — they have `status`/`enabled` lifecycles
  already. Disabling is not archiving; do not add a second lifecycle in this
  change.

**The cascade — implicit freeze, explicit stamp.** Archiving a project does
*not* write `archivedAt` onto its teams/channels/threads. Instead every read
computes **effective-archived = own stamp OR any ancestor's stamp** (one join —
channel lists already join team → project). Children behave archived: hidden
from lists, read-only, no runs. On unarchive, only the parent's stamp clears,
so:

- a channel archived *before* the project stays archived afterwards — its own
  stamp is still set;
- everything else comes straight back.

The alternatives lose. *Stamping children* destroys provenance: unarchiving
the project would resurrect a channel someone deliberately buried months
earlier, or force a "which children?" picker nobody wants. *Blocking on
non-empty* is exactly the current project-delete behaviour the owner is
complaining about. Implicit freeze is also the cheapest to build: no fan-out
transaction, no partial-cascade failure states.

## 2. Where archiving is initiated

| Level | Entry points | Confirm pattern |
|---|---|---|
| Channel | `ChannelSettingsDialog` (existing Archive button, kept) — reachable from the channel header in the main `/channels` surface | Confirm modal (exists), then toast with **Undo** |
| Project | (1) Sidebar project `⋯` menu → "Archive project…"; (2) Project → Settings tab → new **General** section | Confirm modal naming consequences, then toast with **Undo** |
| Task | Existing: card menu + `ArchiveDoneMenu` bulk action | Unchanged (undoable via Archived section) |
| Knowledge page | Existing status control | Unchanged |

The confirm modal is kept (archiving hides things from other people, so a
beat of friction is right), but every archive success toast carries **Undo**,
which simply calls unarchive — cheap because archive is fully reversible.
Delete never gets Undo; it gets typed confirmation (§6).

The sidebar `⋯` menu (`SidebarProjectsSection` already renders one with "Add
new channel" / "Rename project") gains one item, entitlement-gated:

```
┌────────────────────────────────┐
│ Projects                     + │
│ ▸ 📁 Gallus                  ⋯ │
│      ┌─────────────────────────┤
│      │ Add new channel         │
│      │ Rename project          │
│      │ Archive project…        │  ← project/org owner+admin only
│      └─────────────────────────┤
│    # general                   │
│    # hardware                  │
│  2 archived ›                  │  ← muted footer row, only when > 0
└────────────────────────────────┘
```

The "Archive project…" modal copy:

> **Archive “Gallus”?**
> The project and its 4 channels leave the sidebar and become read-only.
> History stays searchable, and any owner or admin can unarchive it later.
> Agents stop running in its channels.
> [Cancel] [Archive project]

Project → Settings grows a **General** section above the board settings
(`ProjectSettingsPage` today is only board style/columns, gated to org
owners; General is gated per §7): Rename, Archive/Unarchive, and — owner-only,
archived-only — Delete.

## 3. Where archived things live: `/settings/archive`

One owning recovery surface, one component. `ArchivePage` at `/settings/archive`
(sidebar Settings nav item "Archive") renders a shared `ArchivedItemsList`
component parameterised by scope. Channel creation, settings, and archive
actions remain on the main `/channels` surface; the separate settings route is
removed.

```
┌ Archive ──────────────────────────────────────────────────────────┐
│  [ Projects · 2 ]  [ Channels · 5 ]        Search archived… ▢     │
│                                                                   │
│  📁 Gallus            archived 2026-07-30 by Ondrej               │
│      4 channels · last activity 2026-07-28                        │
│                                    [Open]  [Unarchive]  [Delete…] │
│                                                                   │
│  # old-standup        archived 2026-05-02 by Marta                │
│      312 messages · team Gallus/Default                           │
│                                    [Open]  [Unarchive]  [Delete…] │
│                                                                   │
│  # launch-week        archived with project “Gallus”              │
│      (unarchives with its project)          [Open]                │
└───────────────────────────────────────────────────────────────────┘
```

Every element drives a decision: *who archived / when* answers "was this
deliberate and whose call was it to reverse?"; *last activity / message count*
answers "is anything of value in here before I delete?"; the three actions are
the three things you can do. Implicitly-archived children render without
Unarchive (the decision lives on the parent, and the row says so). Buttons
appear only when the viewer is entitled (§7) — no 403 bait.

**Finding things months later:** the list has its own filter box, and `/search`
results include archived items marked with a muted `Archived` chip; clicking
opens the read-only view (§4), from whose banner an entitled person can
unarchive. That is the second doorway Rule zero demands: the person standing in
search results with the question "where did that channel go?" gets the answer
there, not via a settings safari. (Dependency: search index keeps archived
items, flagged.)

## 4. Inside an archived thing

Deep links keep working — archive must never orphan a URL.

- **Archived channel:** full history readable. The composer is replaced by a
  banner (composer *removed*, not disabled — a disabled input suggests a bug):
  `This channel was archived by Marta on 2 May · [Unarchive]` (button only if
  entitled; otherwise the sentence stands alone). No new runs: the worker's
  engagement path checks effective-archived before deciding anything, and
  scheduled triggers targeting an archived channel surface an
  "target archived" error state on the Triggers page instead of silently
  burning runs.
- **Archived project:** all tabs open read-only. Same banner across the top of
  `ProjectView`; "New task" and board drag/drop are absent; Docs open
  read-only. Its channels show the channel banner with "archived with project
  “Gallus”".

## 5. Navigation and counts

Archived items **disappear** from working navigation — sidebar sections,
project switcher menu, `/projects` first-project redirect, channel pickers,
assignee/target dropdowns. Greying them out in place would make every list
grow forever, which is what archive exists to prevent. The one trace left
behind is a muted footer row per sidebar section — `2 archived ›` — shown only
when the count is non-zero, linking to `/settings/archive` pre-filtered. That
row is the in-context doorway from the exact place a person notices something
missing; no count is shown anywhere else because no other decision needs it.

## 6. Delete — fixing the defect, and the policy

**The defect, stated plainly:** the channel dialog's Delete button calls the
archive mutation (`ChannelSettingsDialog.tsx:76`), and `DELETE
/api/channels/:channelId` is itself only a soft archive. Two labels, one
action, one of them danger-styled with a "Confirm delete" ritual that delivers
no destruction. Nothing in Nessie can hard-delete a channel today.

**The pick: (a) Delete really deletes — but only what is already archived.**
The exact policy, identical for channels and projects:

1. **Archive is the only disposal action on an active object.** The channel
   dialog and project settings show Archive alone while the object is active.
   The danger-styled Delete button leaves the active-object dialogs entirely.
2. **Delete appears only on archived objects** — on the archived object's
   dialog/settings and on its `/settings/archive` row — and only for **org
   owners**. It is a true hard delete (`prisma.delete`, cascading rows,
   `FileService.delete` for attachments, audit event).
3. **Deleting an archived project deletes its subtree** — teams, channels,
   threads, messages — after a typed confirmation that names the blast radius:
   > **Permanently delete “Gallus”?** This erases 4 channels and 1,230
   > messages. This cannot be undone. Type the project name to confirm.
   The `PROJECT_NOT_EMPTY` guard dies with this; it existed to make owners
   feel the weight of deletion, and archive-first carries that weight better.

Why (a)-with-a-gate beats the alternatives. **(b) — delete disappears** —
contradicts the owner's explicit "I guess we can delete projects, but we
really need to make sure that we have the right permissions", and a
self-hosted platform genuinely needs a true erasure path (data-protection
requests, test debris). **(c) — retention-window purge** — buys the same
cooling-off period this design gets structurally, but pays for it with a purge
worker, countdown copy, and a "reversible until it isn't" promise that must
never fire early; that is machinery the house rules call over-engineering. In
the archive-first model the retention window is exactly as long as you leave
the thing archived — human-controlled, zero new jobs — and deletion is always
a second, deliberate act performed while looking at the archived object.

## 7. Permissions — the matrix

The addendum's asymmetry is real: channel disposal follows `canManageChannel`
(channel **or** team **or** org owner/admin), while project disposal is org
owner only. Consistency means projects get a `canManageProject` mirror —
project owner/admin or org owner/admin (`ProjectMember.role` already exists,
unused for this) — because the person running a project should be able to tidy
it, just as a team admin tidies channels. Destruction, by contrast, is an
org-level decision everywhere: managers tidy, only the org owner erases.

| Object | Archive | Unarchive | Hard delete |
|---|---|---|---|
| Channel | channel/team/org owner or admin (`canManageChannel`, **unchanged**) | same set | **org owner only, archived-only** (*changed*: today's "delete" is a mislabelled archive under `canManageChannel`) |
| Project | project/org owner or admin (**new** `canManageProject`; today: nothing) | same set | **org owner only, archived-only** (*changed*: today org owner + empty-only) |
| Task | project members (unchanged) | unchanged | none — tasks are never hard-deleted |
| Knowledge page | existing status permissions | existing | existing KB rules |
| Team / Thread / Org | — inherit / out of scope — | | |

Unarchive deliberately equals archive: whoever may put a thing away may bring
it back; a stricter unarchive would strand items archived by a departed admin.
The delete narrowing costs nobody anything real — today's channel "delete"
never deleted.

**What each role sees.** Visibility of archived items follows the same
entitlement as when they were active (a member who could read `#old-standup`
can still find and read it; a private channel stays invisible to outsiders).
Actions render only when entitled — Rule zero forbids a Restore button that
403s: a member's archive row shows name, dates, and **Open** only; a
manager adds **Unarchive**; the org owner adds **Delete…**. A member with
nothing visible gets the empty state: *"Nothing in the archive that you can
see. Items you archive, or archived items you're a member of, appear here."*
The API keeps its deliberate 403/404 ambiguity; the UI simply never renders
what the viewer can't act on, driven by a server-supplied `canManage` flag on
each record (the client cannot compute channel/team roles itself).

## 8. Migration of what exists

- **`ChannelSettingsDialog`** — kept and rewired: Archive/Unarchive stays; the
  fake Delete goes; a real Delete appears only when `archivedAt` is set and
  the viewer is org owner.
- **`SettingsChannelsPage`** and its route — removed. `/channels` is the sole
  channel surface for creation, settings, and archive actions; no duplicate
  channel-management list remains.
- **`ArchiveDoneMenu` / Kanban archived section** — kept untouched; it is the
  tone reference (quiet, verb-first, undoable) the new surfaces copy.

## 9. First slice — one week

Ships end-to-end and satisfies Rule zero on day five:

1. Migration: `Project.archivedAt`; endpoints `POST
   /api/projects/:id/{archive,unarchive}` with `canManageProject`; project
   list excludes archived unless `?includeArchived=true`; effective-archived
   join on channel reads.
2. UI: sidebar `⋯` → "Archive project…" + confirm modal; Project Settings
   General section; sidebar `N archived ›` footer rows; `ArchivePage` at
   `/settings/archive` (projects + channels tabs, with the archive facade owning
   its include-archived query);
   read-only banner on archived project tabs and archived channels.
3. **Honesty fix:** remove the lying Delete button from
   `ChannelSettingsDialog` in the same slice — shipping a button that
   fabricates destruction is a live defect, not future work.

Real hard delete (channel + project subtree, typed confirm, `FileService`
cleanup) is slice two: it is the only part with irreversible blast radius and
deserves its own review.

## Server-side dependencies (list, not spec)

- `Project.archivedAt DateTime?` + archive/unarchive endpoints + audit events
  (`project.archived` / `project.unarchived`).
- `canManageProject` (project owner/admin ∨ org owner/admin).
- Effective-archived computed on channel/thread reads (ancestor join);
  `GET /api/projects` filter parity with channels.
- `canManage` (or viewer-role) flag on project/channel records for UI gating.
- Worker: engagement + message-create + trigger dispatch refuse
  effective-archived targets; Triggers page "target archived" state.
- Search: index retains archived items with an `archived` flag.
- Slice 2: real `DELETE` for channel and project (guarded 409
  `*_NOT_ARCHIVED`, owner-only, subtree cascade + `FileService.delete`),
  retiring `PROJECT_NOT_EMPTY` and the archive-masquerading channel DELETE.
