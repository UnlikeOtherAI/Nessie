# Project Kanban — fold Work into a project-scoped work menu

Status: implemented (2026-06-11). Branch `feature/project-kanban`.

## Goal

Replace the separate **Projects** (admin card list) and **Work** (flat task queue)
areas with a single **work-only menu** hosted by the **Projects** rail icon:

- **First item: "Kanban"** (`/projects`) — one board aggregating work items across
  *all* projects.
- **Below it: the projects list** — the Projects rail opens each project overview at
  `/projects/:projectId`, with its scoped Kanban board at `/projects/:projectId/board`.
  The Channels sidebar links to the same placeholder overview in the channels
  context at `/channels/projects/:projectId`.
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
- New aggregate page `pages/AggregateBoardPage.tsx` plus the scoped
  `ProjectBoardTab`: aggregate creates tasks with a project picker and shows a
  project badge on cards; scoped boards create tasks within the active project.
  Legacy tasks with `projectId = null` appear on the aggregate board as
  "Unassigned".
- Task queries/mutations centralized in `facades/tasks/hooks.ts`.
- Members management extracted to `components/shared/ProjectMembersDialog.tsx`.
- Routing: `/projects` → aggregate Kanban; `/projects/:projectId` → project overview;
  `/projects/:projectId/board` → scoped Kanban; `/channels/projects/:projectId` →
  channels-context project overview. `/work` redirects to `/projects` (kept for the
  shipped mobile WebView shell). `WorkPage.tsx` and `ProjectsPage.tsx` deleted.
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

## Update 2026-06-13 — columns fill width, width-driven pagination, header New task

Generalises the phone-only paging from `(4)` into a single width-driven model and
moves the `+ New task` button into the page header (supersedes line 102's
"top-of-board bar" placement and the fixed-width desktop board from `(4)`).

### Board (`admin/`)

- Columns **fill the available viewport width** with a hard floor of
  `MIN_COLUMN_PX = 300` (`KanbanColumn` is `flex-1 min-w-[300px]`). The old fixed
  `280px` columns + desktop `overflow-x-auto` horizontal scroll are gone.
- `KanbanBoard` measures the viewport with a `ResizeObserver` and fits as many
  `>= 300px` columns (plus the `12px` gap) per page as will fit:
  `perPage = floor((width + gap) / (300 + gap))`. Remaining columns move to
  additional pages; pagination dots (`pageCount`) show only when `pageCount > 1`.
  This applies at **every** width, not just phones — a narrow desktop window
  paginates too. When the viewport is narrower than one column, the single column
  fills it.
- Dot taps, horizontal swipe, and drag-to-edge page switching now step whole
  pages (`perPage` columns) and are gated on `paginated` rather than a mobile
  media query. The `useMediaQuery` mobile breakpoint is no longer used by the
  board.
- `handleDragEnd` only moves a card when dropped on an actual column droppable
  (no implicit "current mobile page" fallback).

#### Swipe (mouse + touch + pen)

- Page swiping is unified on **pointer events** (`onPointerDown`), so it works
  with a **mouse drag** as well as a finger/pen — the old touch-only
  `onTouchStart/End` handlers are gone.
- Only a drag on **blank board area** pans pages: a press whose target is inside
  a card (`[data-kanban-card]`) or a control (`button/a/input/...`) is left to the
  card's own click/drag, so dnd-kit card moves and the open-task click are
  unaffected. The gesture completes on `window` `pointerup`/`pointercancel`, so a
  mouse release outside the viewport still registers. A page only changes when the
  horizontal delta clears `SWIPE_PAGE_MIN_PX` and dominates the vertical delta.
- The viewport sets `touch-action: pan-y` so vertical page scroll passes through
  while horizontal drags are reserved for swiping.

### New task button

- Moved from the board content area to the **top-right of the page header**:
  `AggregateBoardPage` header for `/projects`, and `ProjectView` header (Board
  tab only) for `/projects/:id/board`. `ProjectBoardTab` no longer renders it.

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (admin) pass.
- Playwright (isolated, dev-login token) at 1680/1280/1100/760/420px: columns
  fill width (4×332 → 3×313 → 2×386 → 1×388), dots appear at 2/2/2/4 pages, and
  the New task button sits in the header row (`top: 50px`, right-aligned). Project
  board (5 columns) shows 4 + a second page. No console/page errors.
- Swipe verified at 1280px (2 pages): a **mouse drag** on blank board area flips
  to the next/previous page (left→page 2, right→page 1), and a synthetic
  **touch** pointer swipe does the same. No page errors.

## Update 2026-06-13 (2) — animated swipe + long-press to drag on touch

Builds on the pointer swipe: the board is now a sliding carousel and touch drag
is long-press activated so a short touch swipe pages instead of grabbing a card.

### Board (`admin/`)

- The viewport is a **carousel**: columns are chunked into one viewport-wide
  panel per page inside a track that translates `translateX(-page * 100%)` with a
  `transform 320ms` transition, so dot taps / swipes / drag-to-edge all animate
  left↔right. Columns still `flex-1 min-w-[300px]` within their panel, so a page
  fills the width (the `visible` show/hide prop on `KanbanColumn` is gone).
- The swipe now **follows the pointer**: during a drag the track tracks the
  finger/mouse (transition disabled, `translateX(calc(-page*100% + offsetPx))`,
  offset clamped to the first/last page) and snaps to the nearest page on release.
- Drag sensors split from a single `PointerSensor` into **`MouseSensor`
  (distance: 8)** + **`TouchSensor` (delay: 250ms, tolerance: 8)**. On touch a
  card only becomes draggable after a long-press, so a short touch swipe — even
  one that starts on a card — pages the board; a long-press then drag moves the
  card. On mouse/pen a press on a card still starts a card drag (cards are
  excluded from the mouse swipe), and a `cardDragRef` guard stops a card drag from
  also paging. `KanbanCard` now spreads dnd `listeners` (mousedown / touchstart)
  instead of hand-wiring `onPointerDown`.

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (admin) pass.
- Playwright (isolated, dev-login token) at 1280px (2 pages): track transition is
  `320ms`; mid-drag the track follows the pointer (`transition: none`, offset
  ≈ −80px); a mouse swipe pages next/previous and re-enables the transition; a
  synthetic **touch** swipe starting **on a card** pages (short swipe scrolls);
  and a mouse card-drag sets `data-kanban-dragging` without changing the page.
  Layout unchanged at 1680px (4 columns fill) and 1280px (3 + dots). No errors.

## Update 2026-06-13 (3) — wheel/Magic-Mouse paging + cross-page drag fix

### Wheel / trackpad / Magic Mouse swipe

- A **horizontal wheel** gesture (Magic Mouse or trackpad two-finger swipe) now
  pages the board. `KanbanBoard` attaches a non-passive `wheel` listener on the
  viewport: when `|deltaX| > |deltaY|` it `preventDefault()`s (so the browser's
  back/forward swipe-navigation doesn't fire) and accumulates `deltaX`; once it
  clears `WHEEL_PAGE_PX` (40) it turns one page, then locks until the gesture
  goes idle (`WHEEL_IDLE_MS` 150) so one flick = one page. Vertical wheel is left
  alone (page scroll). This is separate from the pointer-drag swipe, which only
  fires on a button-drag — a Magic Mouse swipe is a wheel event, not a drag.

### Cross-page card drag (drag-to-edge paging)

- Dragging a card to the viewport edge pages the board; previously the drop
  target could end up offset by the page width (reported on macOS Safari: the
  drag shadow stayed put and you had to move off the window to drop). Two causes
  addressed:
  - `DndContext` now sets **`autoScroll={false}`** — the board does its own
    drag-to-edge paging, so dnd-kit's auto-scroll (whose overlay/scroll
    compensation drifts in Safari) is redundant and is turned off.
  - The page **transition is disabled while a card is being dragged**
    (`transition: swiping || isDraggingCard ? 'none' : …`) so paging is instant.
    An animating transform makes the drop target a moving target, which
    `MeasuringStrategy.Always` then measures mid-flight. Dot taps and ordinary
    swipes still animate.

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (admin) pass.
- Playwright in **both Chromium and WebKit** (Safari engine), 1280px / 2 pages:
  a horizontal wheel pages right→left and a vertical wheel does not; a
  drag-to-edge cross-page drag pages and, at the new page's centre, the target
  column's dropzone registers as **over** (reachable on screen). No page errors.
  The original Safari offset could not be reproduced headlessly (overlay drift
  was already 0), so the fixes are best-effort for the reported symptom.

## Update 2026-06-13 (4) — native scroll-snap carousel (fixes Safari/iPad drag offset)

Replaces the CSS-`transform` carousel (updates `(2)`/`(3)`) with a **native
horizontal scroll-snap** container.

### Why

Dragging a card from a column on a later page back to an earlier one offset the
drag overlay by ~one page width on macOS/iPadOS Safari (the shadow lagged behind
the finger by the scrolled distance, so you had to drag off-window to drop). Root
cause: the draggable cards lived inside a `transform: translateX` track, and
dnd-kit mis-measures a draggable whose ancestor is transformed (worse on
WebKit/touch). dnd-kit *does* handle native scroll containers correctly.

### Board (`admin/`)

- The viewport is now `overflow-x: auto` + `scroll-snap-type: x mandatory`, with
  one viewport-wide `snap-start` panel per page (no transform anywhere). Scrollbar
  is hidden (`scrollbar-width: none` + `::-webkit-scrollbar`). Columns still
  `flex-1 min-w-[300px]` within a panel, so each page fills the width.
- Paging is the OS's native scroll: **Magic Mouse / trackpad / touch horizontal
  swipes** scroll-snap between pages (this is what fixed the reported "Magic Mouse
  swipe does nothing"), and the dots call `scrollTo({ behavior: 'smooth' })`. The
  current page is read back from `scrollLeft` on `scroll`.
- Cross-page card drags use **dnd-kit's built-in auto-scroll** (re-enabled): drag
  to the viewport edge and the board scrolls to the next page, then drop. Snap is
  set to `none` while a card is dragging so it doesn't fight auto-scroll.
- Touch drag stays long-press activated (`TouchSensor` delay 250ms) and mouse
  drag distance activated (`MouseSensor` 8px), so a short touch swipe scrolls and
  a long-press then drag moves a card.
- Removed the now-unneeded custom code: the pointer-drag swipe handler, the
  `wheel` paging handler, the finger-follow offset/`swiping` state, the
  drag-to-edge paging effect, and `autoScroll={false}`. Net simpler. Note: the
  earlier "button-drag on blank board area to page (plain mouse)" gesture is gone
  — plain-mouse users page via the wheel/trackpad or the dots; a button-drag on a
  card still moves the card.

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (admin) pass.
- Playwright in **Chromium and WebKit**, 1280px / 2 pages: a horizontal wheel
  pages and back; dots page; cross-page card drag triggers dnd auto-scroll, the
  **overlay tracks the pointer (drift 0px)**, and the revealed column registers
  as the drop target. Layout unchanged (4 columns fill at 1680px, 3 + dots at
  1280px), scrollbar hidden. No page errors. The original Safari/touch offset
  could not be reproduced headlessly (WebKit blocks synthetic `Touch`), so this
  is a root-cause structural fix to confirm on the iPad.

## Update 2026-06-13 (5) — drop the drag overlay, settle on drop, pulse the card

### No more drag overlay (the card drags in place)

- Removed dnd-kit's `DragOverlay` + the `KanbanCardPreview` clone. The card now
  drags **in place** via dnd-kit's `transform` on the card element itself
  (raised with `z-50 shadow-xl`, full opacity — no more dimmed ghost + floating
  semi-transparent copy). Because the card is positioned by its own transform
  relative to its layout box, it tracks the pointer correctly regardless of page
  scroll — this removes the last of the Safari/iPad "shadow offset by the scroll
  amount" problem at the root (no fixed-positioned overlay to drift).

### Settle onto a whole page on drop

- On drop, the board scrolls (smooth) to the page that holds the column the card
  was dropped into; if the card was released outside any column it settles to the
  nearest page. So a drag-to-edge auto-scroll never leaves the board parked
  mid-page.

### Pulse the dropped card

- A card that actually changes column on drop pulses **three times**
  (`kanban-card-pulse` in `admin/src/styles.css`: scale 1→1.04 + an `--accent-soft`
  ring, `0.34s × 3`). `KanbanBoard` tracks the moved task id (`pulseId`) and clears
  it on `animationend`.

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (admin) pass; pulse keyframe present
  in the built CSS bundle.
- Playwright (Chromium), 1680px: during a card drag there is **no**
  `[data-kanban-card-preview]` and the dragged card carries a `translate3d`
  transform (follows the pointer in place); dropping it on another column moves
  it there, the landed card shows `kanban-card-pulse`, and the scroll stays
  page-aligned. (Test card moved + restored, no data left changed.)

## Update 2026-06-13 (6) — per-column card ordering; all-projects board removed

### Manual per-column priority order

- `Task` gains a `position Int @default(0)` column (migration
  `20260613130000_add_task_position`, plus `@@index([column_id, position])`).
  `listTasks` orders by `position asc, updatedAt desc` so each column shows its
  manual order (newest-first within the default-0 tie until reordered).
- `POST /api/tasks/:id/move` now takes an optional `position` (target index in the
  destination column). `moveTaskToColumn` pins the column (+ status transition when
  the category changes, as before) and **reindexes that column densely (0..n)** in
  a transaction, placing the moved card at `position`. Order is **per-column only**
  — a card dropped into another column takes a fresh index there.
- Cards are a `@dnd-kit/sortable` list: each column is a `SortableContext`
  (`verticalListSortingStrategy`), so dragging a card up/down opens an **animated
  gap** and reorders; cross-column drags relocate the card into the hovered column
  on `onDragOver` (animated) and drop at the hovered index. `onDragEnd` persists
  via `move({ columnId, position })`. The board keeps a local ordered copy
  (`items`) for instant feedback and resyncs from the server when idle; `useMoveTask`
  no longer optimistically patches (it would fight the dropped order) — it persists
  and refetches.

### All-projects (aggregate) board removed

- The synthetic all-projects board was incompatible with per-column ordering
  (its columns are status categories spanning every project, with no real column
  to order within). `AggregateBoardPage`, the sidebar **Boards › Kanban** entry,
  and `AGGREGATE_COLUMNS` / `CATEGORY_TO_STATUS` are gone. `/projects` now
  redirects to the first project's board (`ProjectsIndexPage`); per-project boards
  are unchanged.

### Verification

- `tsc --noEmit` + `eslint --max-warnings 0` (api + admin) and the api `tsc` build
  pass. Backend: a move with `position` reindexes the column densely and the moved
  card lands at the requested index (verified against the dev API). UI (Playwright,
  Chromium): `/projects` redirects to `/projects/:id/board`, no aggregate sidebar
  link, dragging a card reorders within a column and **persists across reload**, and
  a cross-column drag lands + persists in the target column. No page errors.
