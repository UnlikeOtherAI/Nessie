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
