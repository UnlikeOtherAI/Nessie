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
