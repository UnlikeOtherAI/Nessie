# Project Kanban — fold Work into a project-scoped work menu

Status: implemented (2026-06-11). Branch `feature/project-kanban`.

## Goal

Replace the separate **Projects** (admin card list) and **Work** (flat task queue)
areas with a single **work-only menu** hosted by the **Projects** rail icon:

- **First item: "Kanban"** (`/projects`) — one board aggregating work items across
  *all* projects.
- **Below it: the projects list** — each project (`/projects/:projectId`) *is* its
  own Kanban board, scoped to that project's work items.
- The menu contains **only work** — no channels, DMs, or agents. The **Channels**
  menu (channels / DMs / agents) is unchanged.

Decisions: the standalone **Work** rail icon is removed; project admin (new / rename
/ delete / members) stays **inline** in the menu; the board is a real
drag-between-columns Kanban with four columns — **To do · In progress · Review ·
Done** — and `failed`/`cancelled` behind an Archive toggle.

## Backend — tasks are now project-scoped

Previously `Task` had only `organizationId`. Added:

- **Schema** (`api/prisma/schema.prisma`): `Task.projectId String?` → `Project`
  (`onDelete: SetNull`, nullable so org-wide / agent-run tasks are unaffected) +
  index `@@index([organizationId, projectId, status])`. Migration
  `20260611130000_add_task_project_id` (additive; applied with `migrate deploy`
  because the local DB carries pre-existing drift that `migrate dev` would reset).
- **Contract** (`api/src/contracts.ts`): `TaskRecord.projectId` (`string | null`);
  `CreateTaskBody.projectId` (optional).
- **Routes** (`api/src/routes/tasks.ts`): `GET /api/tasks?project=<id>` filters by
  project; `POST /api/tasks` accepts `projectId` (404 `PROJECT_NOT_FOUND` if it is
  not in the org).
- **Service** (`api/src/services/tasks.ts`): `createHumanTask` validates and persists
  `projectId`; `listTasks` filters by it.
- **Transitions**: the `VALID_TRANSITIONS` map was extended **additively** so the four
  board columns are freely interchangeable in both directions (e.g. `in_progress →
  inbox`, `review → inbox`, `done → review`, `inbox → done`). No existing edge was
  removed, so the agentic worker lifecycle is unaffected.

## Frontend — work menu + Kanban board (`admin/`)

- Removed **Work** from `SidebarRail`. The **Projects** icon routes to `/projects`.
- New route-specific sidebar `layouts/admin-shell/ProjectsSidebarNav.tsx` (a "Kanban"
  item + the projects list with inline New / Rename / Members / Delete), wired through
  `useAdminShell.isProjectsRoute` + `AdminShellLayout`.
- New board under `components/kanban/`: `KanbanBoard` (4 droppable columns + Archive
  toggle), `KanbanColumn`, `KanbanCard` (draggable via `@dnd-kit/core`; drag handle on
  the card body so the assignee select / actions stay clickable), and `kanban-config.ts`
  (column ↔ status mapping). Dragging a card fires an optimistic status transition.
- New page `pages/ProjectKanbanPage.tsx` (replaces `WorkPage`/`ProjectsPage`): reads
  `:projectId` (absent = aggregate board), creates tasks (project picker only on the
  aggregate board), and shows a project badge on aggregate cards. Legacy tasks with
  `projectId = null` appear on the aggregate board as "Unassigned".
- Task queries/mutations centralized in `facades/tasks/hooks.ts`.
- Members management extracted to `components/shared/ProjectMembersDialog.tsx`.
- Routing: `/projects` + `/projects/:projectId` → `ProjectKanbanPage`; `/work` redirects
  to `/projects` (kept for the shipped mobile WebView shell). `WorkPage.tsx` and
  `ProjectsPage.tsx` deleted.
- New dependency: `@dnd-kit/core`.

## Verification

- `tsc --noEmit` (api + admin), `eslint --max-warnings 0` (api + admin), and the
  api/worker/admin production builds all pass.
- Backend verified live against the dev API (5554): `POST /api/tasks` with `projectId`
  returns the task with `projectId` set; `GET /api/tasks?project=<id>` filters; the new
  `in_progress → inbox` transition returns 200 (previously 409).
- Live UI screenshots were **blocked** by a kelpie `navigate` bug (returns
  `success:true` but the tab never leaves the Start Page, both engines) — filed as
  [UnlikeOtherAI/kelpie#78](https://github.com/UnlikeOtherAI/kelpie/issues/78). Playwright
  MCP was not available in this session. UI correctness rests on the passing
  build/typecheck/lint until kelpie is usable again.

## Update 2026-06-12 — ticket detail dialog, priority & deadline

Follow-up to stop cards overflowing and to make every ticket editable.

### Card redesign (`KanbanCard.tsx`)

- Title and excerpt (the task `purpose`) both **wrap** (`line-clamp-3`,
  `break-words`) instead of truncating to one line.
- The inline **assignee dropdown and Cancel/Restore buttons are gone**. Cards now
  show read-only chips: a colour-coded **priority** chip, a **deadline** chip
  (red when overdue), the assignee name, and (on the aggregate board) the project
  pill. Chip styling/date helpers live in `components/kanban/task-meta.ts`.
- The **whole card is clickable** → opens the detail dialog. A pointer-move guard
  (>6px = drag) keeps drag-to-move and click-to-open from colliding.

### Unified create/edit dialog (`TaskDialog.tsx`)

- One modal serves **both** "new task" and "edit task" (same form), reusing the
  `create-channel-panel` shell. Fields: title, excerpt, **priority** (segmented
  Low/Medium/High/Urgent), assignee, **deadline** (`<input type="date">`), and —
  in create mode only — a project picker.
- The top-of-board **"New task" bar is replaced by a `+ New task` button**
  (`NewTaskButton.tsx`) that opens this same dialog. `NewTaskBar.tsx` is deleted;
  `AggregateBoardPage`, `ProjectBoardTab`, and `ProjectBacklogTab` updated.
- Edit mode saves via `PATCH /api/tasks/:id` (title/excerpt/priority/deadline) plus
  the existing `/assign` endpoint when the assignee changed, and offers a
  **Cancel task / Restore** status action.

### Backend — priority + deadline

- **Schema** (`api/prisma/schema.prisma`): new enum `TaskPriority {low, medium,
  high, urgent}`; `Task.priority TaskPriority @default(medium)` and
  `Task.dueDate DateTime?`. Migration `20260612120000_add_task_priority_due_date`
  (additive; `migrate deploy`).
- **Contracts** (`api/src/contracts.ts`): `TaskPrioritySchema`;
  `TaskRecord.priority` + `.dueDate`; `CreateTaskBody` accepts `priority` +
  `dueDate`; `UpdateTaskBody` generalised to `{title?, purpose?, priority?,
  dueDate?, storyPoints?}`.
- **Service/Routes**: `updateTaskStoryPoints` → generalised `updateTask`
  (partial field write); `PATCH /api/tasks/:id` writes any provided subset (400
  `NO_FIELDS` if empty). `createHumanTask` persists priority + dueDate.
- **Client** (`facades/tasks/hooks.ts`): `TaskPriority` type, the two new
  `TaskRecord` fields, `useCreateTask` inputs, and a new `useUpdateTask` mutation.

### React version unify (monorepo)

A fresh worktree `pnpm install` split React across two versions (admin/web on
`^19.2.0` → 19.2.4, the Expo `mobile`/RN side pinned to 19.1.0). Under the
required `nodeLinker: hoisted` (Metro needs a flat tree) this produced **two
React instances** → "Rendered more hooks than during the previous render"
crashes on every page. Unified to a **single React 19.2.4** via root
`pnpm.overrides` (`react`/`react-dom` = `19.2.4`); `mobile` bumped 19.1.0 →
19.2.4 (`react-native@0.81.4` peer is `^19.1.0`, which 19.2.4 satisfies).

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (api + admin + worker) pass.
- Live UI verified in **real Chromium via Playwright** (the kelpie macOS browser
  spuriously throws the "Rendered more hooks" error even though real browsers
  render fine — filed against kelpie): create dialog, edit dialog (pre-filled),
  and an **end-to-end create** with priority *High* + deadline *2026-06-25*
  renders a card with `High` and `Jun 25` chips, persisted through the API/DB.

## Update 2026-06-12 — urgency signal bars, assignee pill, Detail field, wider dialog

Tightened the card header and added a long-form ticket body.

### Card (`KanbanCard.tsx`, `task-meta.ts`)

- The wordy **priority chip** ("Medium" …) is replaced by a Font Awesome
  **`faSignal`** glyph (four ascending bars) tinted by level on a blue → green →
  orange → red ramp: `low → --info`, `medium → --success`, `high → --warning`,
  `urgent → --danger`. The tint map is `PRIORITY_SIGNAL` in `task-meta.ts`
  (replaces the old `PRIORITY_CHIP`); colours stay theme-token only.
- Next to the glyph sits a neutral **assignee pill** — the assignee's name, or
  **"Unassigned"** when none — same size as the old priority chip.
- The glyph + assignee pill now form one **compact row above the title**
  (deadline / archived-status chips pushed to its right), so the meta no longer
  eats vertical space above the heading.

### Dialog (`TaskDialog.tsx`)

- Same signal-bar language on the **priority** control: each option is the
  tinted `faSignal` glyph + label in a 2×2 grid; the active one gets an overlay
  highlight (inactive glyphs dimmed).
- The panel now **fills ~80% of the viewport** (`min(80vw, 1100px)`, scrollable)
  with a **two-column** form — content (Title · Excerpt · Detail) on the left,
  meta (Priority · Assignee · Deadline · Project) on the right.
- New **Detail** field: a long free-text body (10-row textarea) distinct from the
  short **Excerpt** (`purpose`). Persisted on create and edit.

### Backend — task `detail`

- **Schema** (`api/prisma/schema.prisma`): `Task.detail String?`. Migration
  `20260612130000_add_task_detail` (additive). The local dev DB carries
  pre-existing drift that `migrate dev` would reset, so the column was applied
  directly (`ALTER TABLE "tasks" ADD COLUMN "detail" TEXT`) and recorded with
  `prisma migrate resolve --applied`; fresh DBs/CI apply it via `migrate deploy`.
- **Contracts** (`api/src/contracts.ts`): `TaskRecord.detail` (`string | null`);
  `CreateTaskBody.detail` + `UpdateTaskBody.detail` (optional).
- **Service/Routes** (`api/src/services/tasks.ts`, `routes/tasks.ts`): `mapTask`,
  `createHumanTask`, and `updateTask` thread `detail`; `PATCH /api/tasks/:id`
  writes it when present.
- **Client** (`facades/tasks/hooks.ts`): `TaskRecord.detail` plus the
  `useCreateTask` / `useUpdateTask` inputs.

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (api + admin) pass.
- kelpie cannot render this admin (it spuriously throws the "Rendered more hooks"
  crash in `useMediaQuery`/`AdminShellLayout`, unrelated to this code — filed
  against kelpie). Confirmed live on the running dev board (merged to `main`,
  user-reviewed); no automated screenshot captured.

## Update 2026-06-12 (2) — card v2, compact priority row, searchable assignee (people + agents)

Follow-up polish from live review.

### Card (`KanbanCard.tsx`)

- The top **"Unassigned" project pill is gone**: the project pill now renders only
  when the task actually has a project (`showProject && projectName`). Title leads
  the card on the aggregate board for project-less tasks.
- Order is now **title → excerpt → meta row**; the urgency glyph + assignee pill
  sit **below** the title (with deadline/archived chips on the row's right).

### Dialog (`TaskDialog.tsx`)

- **Priority** is a single compact row of four buttons (`flex` + `flex-1`),
  not a 2×2 block.
- **Assignee** is now a **custom searchable combobox** (`components/shared/
  AssigneePicker.tsx`) — type to filter, arrow keys + Enter to pick, Escape to
  close, click-away to dismiss. It lists **people and agents** together (person /
  robot icon per row) and a leading "Unassigned" clear option.

### Backend — assign to a person *or* an agent

- **Schema**: new `Task.assigneeAgentId` (`String?` → `Agent`, `onDelete:
  SetNull`) plus `@@index([assigneeAgentId, status])`. It is a **distinct column
  from the worker's `agentId`** so assigning a task to an agent never enqueues
  agent execution. The existing `Task.agent`/`Agent.tasks` relation gained the
  name `AgentRunTasks`; the new relation is `AgentAssignedTasks`. Migration
  `20260612140000_add_task_assignee_agent` (additive).
- **Contracts**: `TaskRecord.assigneeAgentId`; `AssignTaskBody` and
  `CreateTaskBody` accept `assigneeAgentId`. Assignment to a user and to an agent
  are **mutually exclusive** (agent wins if both supplied; both null = unassign).
- **Service/Routes**: `mapTask` resolves `assigneeName` from the user *or* the
  agent; `assignTask`/`createHumanTask` validate the agent belongs to the org
  (`ASSIGNEE_AGENT_NOT_FOUND`) and write the two columns mutually exclusively.
- **Client** (`facades/tasks/hooks.ts`): `TaskRecord.assigneeAgentId`, plus the
  `useCreateTask` / `useAssignTask` inputs.

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (api + admin) pass.
- API verified end-to-end: `GET /api/tasks` returns 200 with the new `detail` and
  `assigneeAgentId` fields; dev-login token issues correctly.
- Visual layer confirmed live on the running dev board by the user; kelpie is
  unusable for this admin and the Playwright MCP browser was busy this session.

## Update 2026-06-12 (3) — archive done work (Done-column action)

Completed work can now be tucked away without being cancelled.

### Model — `archivedAt`

- **Schema**: `Task.archivedAt DateTime?`. Archiving sets the timestamp; **status
  stays `done`** so it is reversible (unarchive clears it). Migration
  `20260612150000_add_task_archived_at` (additive). Chosen over reusing
  `cancelled` so "done" and "cancelled" stay distinct.
- **Contracts**: `TaskRecord.archivedAt`; `UpdateTaskBody.archivedAt` (so a single
  task can be un/archived via `PATCH`); new `ArchiveDoneTasksBody { olderThanDays?
  }`.
- **Service/Routes**: `archiveDoneTasks` stamps every still-unarchived `done` task
  in the org (or only those whose `updatedAt` precedes the `olderThanDays`
  cutoff). `POST /api/tasks/archive-done` exposes it; `updateTask` writes
  `archivedAt`. **Org-wide** by design — both boards archive all org done-work.

### Board (`admin/`)

- The **Done column** gains a top-right **Archive ▾** button (`ArchiveDoneMenu.tsx`)
  whose popup offers **Archive all done** and **Archive older than a week**.
  `KanbanColumn` gained an optional `headerAction` slot.
- `KanbanBoard` routes any task with `archivedAt` into the **Archived** section
  (alongside failed/cancelled), so archived done-cards leave the Done column.
- The task dialog shows an **Unarchive** action for archived tasks
  (`PATCH archivedAt: null`), beside the existing Restore / Cancel actions.

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (api + admin) pass.
- `POST /api/tasks/archive-done` exercised against the dev API (see commit).
- Visual layer to be confirmed live (kelpie broken; Playwright MCP busy).

## Update 2026-06-12 (4) — phone board paging and drag-edge page switching

The projects board now has a phone-specific one-column paging mode for both the
web admin and native WebView shell.

### Board (`admin/`)

- On phone widths (`<768px`), `KanbanColumn` renders as a full-width page;
  desktop/tablet keeps the existing fixed-width horizontal board.
- `KanbanBoard` shows pagination dots above the columns on phone widths and keeps
  them in sync with dot taps and horizontal swipe gestures.
- While dragging a ticket on phone widths, moving the pointer into the left or
  right edge zone switches to the adjacent column page so the card can be dropped
  there, with a drag overlay keeping the ticket visible while the page changes.
- `KanbanCard` text is non-selectable, so drag gestures do not highlight card
  titles or excerpts.
