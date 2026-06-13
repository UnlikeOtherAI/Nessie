# Per-project board settings: custom columns + Kanban/Scrum

Status: implemented (2026-06-11). Branch `feature/project-kanban`. Follows
[2026-06-11-project-kanban-menu.md](./2026-06-11-project-kanban-menu.md).

## Goal

Each project configures its board in a per-project **Settings** tab: **custom
columns** and a **board style** — **Kanban** (continuous board) or **Scrum**
(backlog + time-boxed iterations with story points, velocity, burndown).

## Core invariant — "make it work with all the logic"

`Task.status` stays the single source of truth for the worker, approvals,
transitions, and realtime. Columns and iterations are an *additional placement
layer* keyed off status; the worker is never modified. The worker only ever sets
`inbox`/`in_progress`/`done`/`failed`, so:

- A card with no `columnId` auto-places by status into the first column whose
  **category** (`todo|in_progress|review|done`) matches (`placeTask`,
  `admin/src/components/kanban/kanban-config.ts`). Agent-created tasks therefore
  appear correctly with zero worker changes.
- Agent tasks have `iterationId = null` → they land in the **Backlog** of a scrum
  project until a human plans them into a sprint.

## Data model (additive, nullable)

- `Project.boardStyle` (`BoardStyle {kanban,scrum}`).
- `BoardColumn` (`{name, category ColumnCategory, position}`) — many per project;
  `Task.columnId` (FK, SetNull) pins a card to a column.
- `Iteration` (`{name, goal?, status IterationStatus{planned,active,completed},
  startDate?, endDate?, capacity?, position, completedAt?}`); `Task.iterationId`
  (FK, SetNull) + `Task.storyPoints`.
- Migrations `20260611140000_add_board_columns` (seeds the 4 default columns for
  every existing project) and `20260611150000_add_iterations`. Applied via
  `migrate deploy` (local DB carries drift `migrate dev` would reset).

## API

- **Board:** `GET/PATCH /api/projects/:id/board`; `POST/PATCH/DELETE
  /api/projects/:id/columns[/:columnId]` (owner-gated). `POST /api/tasks/:id/move
  {columnId}` pins a column and syncs status via the validated transition (drags
  between same-category columns only move the pin).
- **Iterations:** `GET/POST /api/projects/:id/iterations`; `PATCH/DELETE
  /api/iterations/:id` (owner) — `action:'start'` enforces a single active sprint,
  `action:'complete'` carries unfinished tasks to the next planned sprint (done
  work stays). `POST /api/tasks/:id/iteration {iterationId|null}`; `PATCH
  /api/tasks/:id {storyPoints}`. Iteration records carry
  `taskCount/pointsTotal/pointsDone`.
- **Insights:** `GET /api/projects/:id/insights` → velocity (Σ done points per
  completed sprint) + active-sprint burndown derived from `TaskEvent
  status_changed→done` timestamps (no snapshot table).
- `TaskRecord` gains `columnId`, `iterationId`, `storyPoints`.

## Frontend (`admin/`)

- `/projects` = aggregate board (canonical category columns). `/projects/:id` =
  tabbed `ProjectView` with an **Overview** placeholder. The scoped board lives at
  `/projects/:id/board`, with **Settings** plus **Backlog · Insights** when the style
  is scrum.
- Settings: style toggle + columns editor (add/rename/reorder/category/delete).
- Backlog: sprint create/start/complete/delete, assign tasks to sprints, inline
  story points; Board scopes to the active sprint with an empty-state CTA.
- Insights: lightweight SVG velocity bars + burndown line (no chart lib).
- Facades: `facades/board/hooks.ts`, `facades/iterations/hooks.ts`; task hooks
  gain `useMoveTask`, `useSetTaskIteration`, `useUpdateTaskPoints`.

## Verification

- Migrations applied; `tsc` + `eslint --max-warnings 0` (api+admin) + api/worker/
  admin production builds pass.
- API verified live (dev-login token): columns CRUD + `move` (status sync);
  iteration lifecycle incl. start/complete **carry-over**; insights velocity +
  burndown (remaining drops on the done-event day, ideal line linear).
- Worker compiles unchanged; agent tasks auto-place by status (`columnId` null)
  and land in the backlog for scrum.
- Live UI screenshots still blocked by [kelpie#78](https://github.com/UnlikeOtherAI/kelpie/issues/78);
  eyeball in the authenticated browser until resolved.
