# Brief: archive / unarchive across Nessie — UI proposal wanted

You are one of three independent reviewers asked to produce a **UI/UX design
proposal** (not an implementation) for archive & unarchive in Nessie's admin
web UI (`admin/`, React + React Router, port 5455 in dev).

## The ask, in the owner's words

> "There is no way of archiving. I don't want to delete it. Any channel or
> project we should only archive so that we can potentially unarchive them in
> the admin. They should have archived projects and archived channels so we can
> bring them back from the dead, but there's no way to do that. It needs to
> work on every level."

"Every level" = the whole hierarchy: **Organisation → Project → Team → Channel
→ Thread**, plus the sibling object types that already carry a half-built
notion of archiving (tasks, knowledge pages/spaces, agents, triggers,
workflows). Deletion should stop being the normal disposal path; archive should
be, with a reliable route back.

## Verified current state (read from the code, 2026-08-12)

Schema (`api/prisma/schema.prisma`):

- `Channel.archivedAt DateTime?` — exists.
- `Task.archivedAt DateTime?` — exists.
- `KnowledgePageStatus` enum has `archived` (draft | published | archived).
- **`Project` has no archive field at all.** No `archivedAt`, no status.
- **`Team` has no archive field.** `Thread` has no archive field.
- `Agent` has a `status` enum (`idle` etc.) but no archive concept.
- `Organization` — not checked in depth; assume no archive.

API:

- `POST /api/channels/:channelId/archive` and `/unarchive` exist
  (`api/src/routes/channels.ts:252,272`). `DELETE /api/channels/:id` is a
  **soft delete that just archives** (`channels.ts:292`).
- `GET /api/channels` excludes archived unless `?includeArchived=true`
  (`api/src/services/channels.ts:48`).
- **`DELETE /api/projects/:projectId` is a real hard delete**
  (`api/src/routes/projects.ts:201`) — owner-only, refuses with 409
  `PROJECT_NOT_EMPTY` when the project still has channels. So the only way to
  dispose of a project today is: destroy every channel first, then destroy the
  project. That is exactly what the owner does not want.
- No archive endpoints for projects, teams or threads.

Admin UI:

- Channel archive is reachable from two places only:
  `admin/src/components/shared/ChannelSettingsDialog.tsx` (Archive /
  Unarchive button + confirm modal) and
  `admin/src/pages/settings/SettingsChannelsPage.tsx` (`/settings/channels`,
  which lists Active and an "Archived" section with an Unarchive button).
- `admin/src/facades/channels/hooks.ts` has `useAllChannels`
  (`?includeArchived=true`) and `useArchiveChannel`.
- Projects: `/projects`, `/projects/:id` with tabs board / backlog / insights /
  docs / settings (`admin/src/pages/project/`). **No archive UI whatsoever.**
- Route table is `admin/src/router.tsx` (~50 routes; `/settings/*`,
  `/projects/*`, `/channels/*`, `/agents/*`, `/ops/*`, `/knowledge-base`,
  `/work`, `/search`, `/audit`).
- Kanban has `admin/src/components/kanban/ArchiveDoneMenu.tsx` — an existing
  bulk-archive affordance for done tasks, worth studying as prior art for tone
  and placement.

So: channels are ~70% there but the entry points are thin and the archived list
is buried in Settings; projects/teams/threads have nothing at all.

## Project standards you must design within

These are enforced house rules (`AGENTS.md` "Rule zero", `CLAUDE.md`):

1. **A capability is not done until a person can reach it.** Every capability
   needs one *owning surface* AND at least one *in-context entry point* on the
   screen where the person is standing when the question arises. One page
   nobody has a reason to open does not count.
2. **Scope by entitlement, never by ambient session context.** An archived-items
   list shows what the caller is allowed to see, per RBAC — never narrowed
   silently by the session's project/team claim.
3. **Every element names the decision it drives.** If a number, row or chip
   doesn't drive a decision, cut it. Short, all-signal screens.
4. **Reuse the surface; never fork it.** The same view appearing in two places
   is one component parameterised by scope, not a second implementation. (The
   project Docs tab already reuses the knowledge workspace this way.)
5. Owner-only operational telemetry never appears on member-facing surfaces.
6. Design system: all colour lives in `admin/src/styles.css` as CSS custom
   properties; components use `var(--x)` / `bg-[var(--x)]` tokens only. No raw
   hex, no Tailwind named colours. Multiple themes exist.
7. Code files 500 lines max. No over-engineering, no speculative generality.

## What your proposal must answer

Be concrete and opinionated. Name screens, routes, component names, copy, and
states. A reviewer reading it should be able to build from it.

1. **The mental model.** Is archive one org-wide concept with one shared
   surface, or per-object-type? Is it a lifecycle state, a soft-delete, or a
   "cold storage" tier? What does archiving a *parent* do to its children —
   does archiving a project cascade to its teams/channels/threads, mark them
   implicitly-archived, or block on non-empty like the current delete does?
   What happens on unarchive — does everything come back, or only what was
   explicitly archived at that level? This cascade question is the crux; give a
   clear answer and defend it.
2. **Where archiving is initiated,** per level (org, project, team, channel,
   thread, task, knowledge page, agent, trigger, workflow). Exact placement:
   which menu, which dialog, which row affordance. Include the confirm/undo
   pattern (modal? toast with undo? both?).
3. **Where archived things live and how they come back.** Is there a single
   `/archive` surface? A per-scope "Archived" filter/toggle? Both? How does a
   person find a specific archived channel three months later — search
   integration? What does the archived list show so each row drives a decision
   (who archived, when, size/activity, restore, permanently delete)?
4. **What an archived thing looks like when you're *in* it** — an archived
   channel you deep-link into, an archived project's board. Read-only banner?
   Composer disabled? Can agents still run in it? (Assume: no new runs, history
   readable.)
5. **Navigation & counts.** Where does the archived state show in the sidebar,
   project list, channel list? Do archived items disappear entirely, grey out,
   collapse into a footer row ("3 archived")?
6. **The relationship to delete.** Does hard delete survive at all, and if so
   for whom (owner-only, from the archive surface, with a retention window)?
   Propose the exact policy.
7. **Empty, permission-denied, and partial states.** What a member sees vs an
   admin vs an owner.
8. **Migration of what exists** — the two current channel-archive entry points
   and the Settings → Channels list: keep, absorb, or replace?
9. **The minimum first slice.** If only one week of work were available, what
   ships first and still satisfies Rule zero?

Also flag any **server-side changes** your UI implies (new fields, endpoints,
list filters, RBAC verbs) — briefly, as a dependency list, not a spec.

## Addendum — the owner's clarification, and a defect it exposes

The owner points out that the channel settings pop-up already offers **both
Archive and Delete**, and adds two requirements:

> "I guess we can delete projects, but we really need to make sure that we have
> the right permissions to do that. Also, we need to make the system
> consistent. You know how we handle channels. We should handle projects as
> well."

So the target is **not** "archive replaces delete everywhere." It is: *channels
have Archive + Delete; projects should work the same way, with permissions that
are actually right.* Channel behaviour is the reference model; projects are the
thing that must be brought into line. Extend that same model up and down the
hierarchy (org, team, thread) where it makes sense — and say where it does not.

**A defect you must account for.** The channel dialog's Delete button is not a
delete. `handleDelete` in
`admin/src/components/shared/ChannelSettingsDialog.tsx:76` calls the *archive*
mutation (`archiveChannel.mutateAsync({ archived: true })`) — it does not even
call the DELETE endpoint. And `DELETE /api/channels/:channelId`
(`api/src/routes/channels.ts:292`) is itself only a soft archive. So today
"Archive" and "Delete" are the same action wearing two labels, one of them
danger-styled with a "Confirm delete" state that implies destruction and
delivers none. Nothing in Nessie can currently hard-delete a channel.

Your proposal must resolve this honestly. Pick one and defend it:
(a) Delete really deletes, and the button starts telling the truth;
(b) Delete disappears from the channel dialog because archive is the only
disposal path; or (c) Delete means "archive now, purge after a retention
window" — a real, dated, reversible-until-it-isn't promise. Whatever you pick
must apply identically to projects.

**Permissions as they actually stand** (verify, don't trust this summary):

- Channel archive/delete → `canManageChannel`
  (`api/src/services/channels.ts:181`): allowed for channel `owner`/`admin`,
  **or** org `owner`/`admin`, **or** the owning team's `owner`/`admin`. Failure
  is a 403 `CHANNEL_FORBIDDEN` that deliberately does not distinguish
  "not found" from "not permitted".
- Project delete → `requireOwner`, org **owner only**, plus the 409
  `PROJECT_NOT_EMPTY` guard.

That asymmetry is part of what "the right permissions" means. A team admin can
dispose of a channel; only an org owner can dispose of a project. Is that
correct, or should project disposal follow a project-manager role the way
channels follow a channel/team manager role? State the permission matrix you
propose — **who can archive, who can unarchive, who can delete, at each
level** — and say which of today's rules you are changing and why. Note that
Rule zero requires the UI to scope by entitlement: a person who cannot restore
an item should not be shown a Restore button that 403s.

Fold these requirements into the numbered questions above rather than answering
them separately; question 6 (relationship to delete) and question 7
(permission states) now carry most of the weight.

## Format

Markdown. Lead with a one-paragraph summary of your chosen model, then the
sections. Include at least one ASCII wireframe of your main archive surface and
one of an in-context entry point. Be decisive — where you see a fork in the
road, pick a branch and say why the other one loses. 1,500–2,500 words.
