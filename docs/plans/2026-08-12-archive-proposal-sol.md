# Archive and unarchive proposal

Nessie should have one understandable lifecycle model and one recovery surface: **Archive is reversible, Delete is permanent, and an archived parent makes its descendants inactive without rewriting their own state.** The owning recovery surface is `/archive`; the doorway is always beside the object in its existing context. Projects and channels use the same controls, copy, permission reporting, and server semantics. Delete remains because the owner explicitly wants it, but it becomes truthful: only an organisation owner can permanently delete an already archived object, with an impact summary and typed confirmation. Archive is the normal disposal action; it retains history indefinitely and never starts a hidden purge clock.

## 1. Mental model and parent behaviour

Archive is a lifecycle state, not soft-delete copy and not cold storage. A directly archived object records `archivedAt` and `archivedBy`; an object is **effectively archived** when it or any ancestor is archived. Active lists, navigation, scheduling, messaging, and run creation exclude effectively archived objects. Exact deep links and the Archive surface may still read them when the caller is entitled.

Archiving a project does **not** stamp every team, channel, thread, task, or page below it. It stamps the project once; descendants become “Archived with project Atlas.” This is both safer and cheaper than a cascade, and it preserves intent. On restore, only the project returns. A channel that was explicitly archived before the project stays archived; an otherwise active channel returns. The same rule applies at organisation, project, team, and channel boundaries.

Archive does not block on non-empty containers. It atomically prevents new messages, tasks, scheduled deliveries, workflow starts, and agent runs in the effective scope. Already-running work may settle into history, but no retry may begin a new logical run after the archive boundary. Triggers and workflow installations suppressed by an ancestor keep their own paused/disabled state and do not silently become active on restore.

`Thread` is the exception. In the current model a channel owns one durable `Thread`, while reply “threads” are message-root views inside it. Giving either an independent archive switch would create an active channel with no usable feed or misrepresent a reply as a hierarchy node. The durable thread inherits its channel; reply conversations may later gain **Close replies**, but they do not appear in Archive.

Organisation archive is presented as **Deactivate organisation**, because it ends access rather than tidies a list. It lives under Settings → Organisation → Lifecycle and is owner-only. Completion redirects to a pre-session `/workspaces` chooser; its Archived section is the restore doorway. Do not ship organisation deactivation until that out-of-org restore route exists. The current team-based `WorkspaceSwitcher` alone cannot restore an inaccessible organisation.

## 2. Initiating archive, and the confirmation pattern

Use shared `LifecycleActions`, `ArchiveConfirmDialog`, and `DeleteConfirmDialog` components, supplied with type, name, impact, and server-returned capabilities. They render through existing header actions and dialogs; they do not become page-specific copies.

- **Project:** add `Archive project…` to the `ProjectView` header More menu and the row menu in `ProjectsSidebarNav`. Project Settings gains a final **Lifecycle** section containing the same component.
- **Team:** add a Teams section to Project Settings. Each `ProjectTeamRow` has a More menu with `Archive team…`; an archived team is restored from `/archive?type=team&projectId=…`.
- **Channel:** keep `ChannelSettingsDialog`, but replace its two misleading buttons with a Lifecycle section. An active channel shows `Archive channel…`; an archived channel shows `Restore channel` and, for an organisation owner, `Permanently delete`. The project/channel sidebar row More menu also exposes Archive for callers with that capability.
- **Thread:** no independent action, for the model reason above.
- **Task:** keep `ArchiveDoneMenu`. Add `Archive task` to `TaskDialog` for done/cancelled tasks; active work must first be completed or cancelled. The board’s existing Archived section remains the local doorway.
- **Knowledge page/space:** add `Archive page…` to the page overflow and `Archive space…` to `SpaceSettingsDialog`. Archive must retain versions and files; today `DELETE /api/knowledge-base/pages/:pageId` purges files before setting archived status, so it cannot remain the archive implementation.
- **Agent:** add `Archive agent…` to the detail-column More menu. An executing/thinking agent must be stopped first. Personal assistants and system-managed agents do not expose this control; their owning integration manages their lifecycle.
- **Trigger:** keep Pause as the operational control and replace normal `Delete trigger` in `TriggerDetail` with `Archive trigger…`. Restoring returns it paused, never firing.
- **Workflow:** add `Archive workflow…` to `WorkflowTemplateDetail`. Its installations become suppressed by ancestry and retain their own status; restore does not activate a disabled installation.

Containers (organisation/project/team/channel/space/agent/workflow) use a modal because the action disables downstream work. Copy is specific: “Archive Atlas? 3 teams and 8 channels will become read-only. Existing history is kept. You can restore it later.” On success, show a ten-second toast: “Atlas archived — Undo.” Individual completed tasks and pages may archive immediately with the same Undo toast. Restore is immediate and shows `Restored` plus `View`; a parent-required restore instead links to that parent.

The project entry point should read like this:

```text
┌ Atlas                                      Overview  Board  Docs  More ▾ ┐
│ More                                                               │
│   Members                                                          │
│   Project settings                                                 │
│   ───────────────────                                              │
│   Archive project…                                                 │
└────────────────────────────────────────────────────────────────────┘
```

## 3. The Archive surface and recovery

Add `/archive` under Admin → Organisation, visible to every authenticated caller. It is the single owning recovery surface; local Archived sections render the same parameterised `ArchiveList`/`ArchiveRow` components with a scope prop.

```text
Archive
[ Search archived items…                         ] [Type: All ▾]
[Structure] [Work] [Knowledge] [Automations]

Atlas                                      Project        [Restore] [•••]
Archived 12 Aug by Maya · last activity 2 Aug
3 teams · 8 channels affected

#launch                                    Channel        [Restore] [•••]
Atlas / Marketing · archived 4 Jun by Jo · last activity 29 May

Design                                     Team
Archived with project Atlas                         [Restore Atlas]
```

Rows show only facts that drive restore or deletion: name, type, hierarchy path, direct versus inherited archive, who/when, last activity, and child counts for containers. Do not show raw storage or operational telemetry. The delete confirmation fetches a fresh impact summary—messages, documents/files, tasks, bindings, and blocked active work—where those counts decide whether to proceed.

The default list shows directly archived roots so a project does not create hundreds of duplicate rows. Search may reveal affected descendants and labels them `Archived with project …`. Type and explicit project/team filters are user-selected, never inferred from session project/team claims. Server pagination and filtering use the complete entitlement set.

Global text search adds an **Archived** group after active results for entitled projects and channels, with an Archived badge and direct link. Archived messages stay out of ordinary global results; searching their content belongs inside the read-only channel or Archive view. This makes a three-month-old channel findable without polluting daily search.

## 4. Behaviour inside an archived scope

Exact archived deep links remain readable. `ArchivedScopeBanner` sits below `AdminPageHeader`/`ChannelHeader`: “This channel is archived. History is read-only.” It offers Restore only when `canUnarchive`; inherited copy says “This channel is read-only because project Atlas is archived” and targets the project.

For channels, replace `ChannelComposer` with a non-interactive strip: “Archived channels are read-only. Restore this channel to post or run agents.” Disable calls, joins, edits, reactions, uploads, DeepWater launch, and agent invitation; message search and history remain. This also fixes the current dangerous fallback where `/channels/:archivedId` is absent from `useChannels()` and `ChannelsPage` silently opens the first active channel.

An archived project keeps Overview, Board, Backlog, Insights, and Docs readable, but removes `New task`, drag/drop, sprint mutation, page editing, and all create buttons. Its Settings page renders identity and lifecycle only. Server guards, not disabled controls alone, enforce no new work or runs.

## 5. Navigation and counts

Archived items disappear from active sidebars and favorites; favorites are preserved and return on restore. Do not grey them into everyday navigation. At the end of the Projects section, show `3 archived projects` only when non-zero; within an active project’s Channels section show `2 archived channels`. Both are links to scoped `/archive` views. The permanent Admin → Organisation → Archive item has no total badge: a cross-type number is not actionable and may be enormous once tasks/pages participate.

`ProjectsIndexPage` redirects to the first active entitled project only. If none exist, its empty state says either “No active projects” with `View archived projects`, or “No projects yet” with Create when permitted.

## 6. Delete is real, staged, and rare

Choose option **(a): Delete really deletes**. `DELETE /api/channels/:id` must stop aliasing archive, and `ChannelSettingsDialog.handleDelete` must stop calling the archive mutation. Projects use identical semantics.

Permanent delete is available only when the object is directly archived, only to an organisation owner, and only after a fresh server preflight. The dialog requires typing the exact name and says what is destroyed. Deleting a project purges its owned subtree; deleting a channel purges its thread/messages and owned attachments. Shared users/agents remain and are detached. Active runs, legal holds, or integration work return a specific blocking state rather than partial deletion. A domain purge service must remove database and object-store data transactionally/idempotently and retain a minimal audit tombstone. There is no Undo and no invented retention date.

Organisation deletion is not self-service in this surface; it belongs to the separate export/erasure workflow. The alternative “Delete means archive” loses because it is today’s defect. A delayed purge loses because Nessie has no retention scheduler or truthful dated contract yet.

## 7. Permissions, empty, denied, and partial states

The API returns `canArchive`, `canUnarchive`, and `canDelete` per record. The UI never infers these solely from `me.user.roleIds` or `ChannelRecord.memberRole`; today `ChannelHeader` shows settings based on type, while project actions only consider org-owner status, so both can drift from actual memberships.

| Object | Archive and unarchive | Permanently delete |
| --- | --- | --- |
| Organisation | organisation owner | no self-service action |
| Project | org owner/admin or project owner/admin | org owner only |
| Team | org owner/admin, project owner/admin, or team owner/admin | org owner only |
| Channel | org owner/admin, project owner/admin, team owner/admin, or channel owner/admin | org owner only |
| Thread | inherited from channel; no action | no action |
| Task / knowledge | caller with the existing edit entitlement | org owner only |
| Agent / trigger / workflow | org owner initially; broaden only with a real resource-manager entitlement | org owner only |

This preserves channel managers’ current archive authority, adds the missing project-manager path, adds project managers to channel management, and narrows channel Delete from every channel manager to org owners because it becomes destructive. Archive and unarchive are symmetric.

`/archive` returns only readable records. A readable row without restore permission has no Restore button and says who can restore it. An unknown or unreadable deep link remains 404, not a permission oracle. An empty surface says “Nothing archived that you can access”; it never reveals an organisation-wide count. Failed restore leaves the row in place with inline retry. If an ancestor is still archived, the child action becomes `Restore Atlas first`, never a request that predictably 409s or 403s.

## 8. Migration of existing surfaces

Keep `ChannelSettingsDialog` as the channel’s owning settings surface in the
main `/channels` workspace, rebuilding its Lifecycle section with shared
components and truthful actions. Remove the separate Settings → Channels page,
route, and navigation item. The main Channels surface owns channel creation,
settings, and archive actions.

The current `POST /archive` and `/unarchive` routes remain canonical. The current channel `DELETE` becomes permanent delete. Project gains matching archive/unarchive routes and `includeArchived`; its existing `DELETE` adopts the staged permission/preflight contract. `ArchiveDoneMenu` and the Kanban Archived section remain useful local affordances.

## 9. Minimum first slice: one week

Ship projects and channels end-to-end, not a thin API slice: Project lifecycle fields and audit metadata; exact archived detail loaders; effective read-only guards; server-returned capabilities; project archive/unarchive; truthful owner-only channel/project Delete; `/archive` with searchable Project and Channel filters; the project header/sidebar and channel settings doorways; scoped archived counts; read-only banners; and global search’s Archived name results. Reuse `ArchiveList`, `ArchiveRow`, and lifecycle dialogs everywhere. Do not start team/task/knowledge/automation UI until this slice is verified, but design the contracts so those types can join without a second surface.

Acceptance requires a project manager to archive and restore a non-empty project, an org owner to permanently delete an archived test project/channel, a member to see no forbidden action, an explicitly archived child to remain archived across parent restore, and archived deep links to open the correct read-only object. UI tests cover keyboard and mobile overflow; Playwright verifies `/archive`, both in-context menus, banners, confirmations, Undo, empty/denied states, and every theme.

## Server-side dependencies

- Add archive actor/time fields where absent and a shared service that computes direct/effective lifecycle through ancestry; do not duplicate guards in routes.
- Add entitled `includeArchived` list filters, exact detail reads, archive/unarchive mutations, lifecycle capability flags, actor display metadata, impact preflight, and searchable archive results.
- Enforce effective archive at message/task/document mutations, trigger/workflow dispatch, run creation/retry, channel join/call, and agent binding boundaries.
- Emit audit events for archive, restore, denied attempts, and permanent deletion; keep 404/403 non-disclosure consistent.
- Implement real idempotent purge for channel/project data and object storage. Archive paths—including knowledge—must never purge content.
- Update shared runtime schemas and domain facades; use TanStack Query invalidation across active, exact-detail, search, sidebar-count, and archive keys.
