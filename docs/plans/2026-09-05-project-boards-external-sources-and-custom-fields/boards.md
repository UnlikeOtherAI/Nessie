# Boards — many views over one task pool

Part of [the project boards design](overview.md).

## 3. Boards (A)

### 3.1 A board is a view

A project has one pool of tasks. A board is a saved way of looking at it: its
own name, its own style, its own columns, and a closed filter. Two boards over
the same tasks are two views; dragging a card on one board never moves it out
of the other. Deleting a board deletes columns and placements — never a task.

That is the whole reason the answer is *view*. A container would have forced
every task to be born into one board, made a Jira-fed board and a team's
working board mutually exclusive over the same tickets, and forced the worker
lifecycle — which knows nothing about boards — to pick one.

### 3.2 Model

```prisma
enum BoardStyle { kanban scrum }          // unchanged, now on Board

model Board {
  id              String     @id @default(uuid()) @db.Uuid
  projectId       String     @map("project_id") @db.Uuid
  organizationId  String     @map("organization_id") @db.Uuid
  name            String
  style           BoardStyle @default(kanban)
  /// The board `/projects/:id/board` opens on with no `?board=`, and the one
  /// the PA tools use when none is named. Exactly one per project: a partial
  /// unique index in the migration (Prisma cannot express it).
  isDefault       Boolean    @default(false) @map("is_default")
  position        Int
  /// BoardFilter (packages/schemas/src/boards.ts) — strict and closed:
  /// { sources: 'all' | 'native' | uuid[]; field?: { fieldId, optionIds[] } }
  filter          Json       @default("{}")
  createdByUserId String?    @map("created_by_user_id") @db.Uuid
  createdAt       DateTime   @default(now()) @map("created_at")
  updatedAt       DateTime   @updatedAt @map("updated_at")

  project      Project              @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organization Organization         @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  columns      BoardColumn[]
  placements   TaskBoardPlacement[]

  @@index([projectId, position])
  @@map("boards")
}

model BoardColumn {
  id             String         @id @default(uuid()) @db.Uuid
  boardId        String         @map("board_id") @db.Uuid          // was projectId
  organizationId String         @map("organization_id") @db.Uuid
  name           String
  category       ColumnCategory
  position       Int
  /// [{ sourceId, externalStateId }] — external states this column shows
  /// and writes back to. Empty for a column with no binding (§5.8).
  stateBindings  Json           @default("[]") @map("state_bindings")
  createdAt      DateTime       @default(now()) @map("created_at")
  updatedAt      DateTime       @updatedAt @map("updated_at")

  board        Board                @relation(fields: [boardId], references: [id], onDelete: Cascade)
  organization Organization         @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  placements   TaskBoardPlacement[]

  @@index([boardId, position])
  @@map("board_columns")
}

/// One row per (task, board) a person or the PA has explicitly placed. Absent
/// means "wherever the status says" (§3.3). Written only by a move.
model TaskBoardPlacement {
  taskId    String   @map("task_id") @db.Uuid
  boardId   String   @map("board_id") @db.Uuid
  columnId  String   @map("column_id") @db.Uuid
  position  Int      @default(0)
  updatedAt DateTime @updatedAt @map("updated_at")

  task   Task        @relation(fields: [taskId], references: [id], onDelete: Cascade)
  board  Board       @relation(fields: [boardId], references: [id], onDelete: Cascade)
  column BoardColumn @relation(fields: [columnId], references: [id], onDelete: Cascade)

  @@id([taskId, boardId])
  @@index([columnId, position])
  @@map("task_board_placements")
}
```

`Project` loses `boardStyle` and gains `boards Board[]`. `Task` loses
`columnId`, `position` and their two indexes, and gains `placements
TaskBoardPlacement[]`. `Iteration` is untouched: a sprint is a project-level
time box (§3.6).

### 3.3 The placement rule — one function, server-side

`resolveBoardPlacement` in `packages/team-admin/src/board-placement.ts`
replaces the client's `placeTask` and fixes T3:

```
category = statusToCategory(task.status)            // null ⇒ archived, on no board
columnsOfCategory = board.columns where category matches, by position
if none                                            ⇒ not shown on this board
pin = placement(task, board)
if pin and pin.column.category == category         ⇒ { pin.columnId, pin.position }
if task.externalLink and a column binds
   (link.sourceId, link.remoteStateId)             ⇒ { boundColumn.id, position: null }
else                                               ⇒ { columnsOfCategory[0].id, position: null }
```

Consequences, each deliberate:

- **A stale pin is ignored, not honoured.** When the worker flips `status` to
  `done`, every board shows the card in its first Done column, whether or not
  someone once dragged it into "In progress". The pin row is left in place
  (the worker does not know boards) and is overwritten by the next drag;
  `moveProjectTaskToColumn` and `transitionProjectTask` additionally delete
  placements whose column category no longer matches, so data written by the
  board itself is never stale.
- **A board's column set is a filter.** A triage board with only `todo`
  columns shows only unstarted work. Nothing else is needed to make a
  "Review queue" board.
- **Ordering within a column** is placed rows by `position`, then unplaced
  rows by `updatedAt desc`. On a drop, `reindexColumn` first materialises a
  placement for every task currently rendered in that column on that board (in
  the order the person saw) and then reindexes — so after one drag the column's
  order on that board is fully explicit, and a second drag cannot shuffle it.

`statusToCategory` / `categoryToStatus` move from `kanban-config.ts` and
`project-task-move.ts` into `packages/schemas/src/board-lifecycle.ts` so the
server and the admin import one map. The client keeps a grouping step only.

### 3.4 Migration — `api/prisma/migrations/20260906100000_project_boards/`

One additive-then-destructive migration, in this order, all in SQL:

1. `CREATE TABLE boards …`; insert one row per project:
   `name = 'Board'`, `style = projects.board_style`, `is_default = true`,
   `position = 0`, `organization_id = projects.organization_id`.
2. `ALTER TABLE board_columns ADD COLUMN board_id uuid`; set it to the
   project's default board; `SET NOT NULL`; drop `project_id` and its index;
   add `(board_id, position)`; add `state_bindings jsonb NOT NULL DEFAULT '[]'`.
3. `CREATE TABLE task_board_placements …`; insert
   `(task_id, board_columns.board_id, column_id, position)` for every task with
   a non-null `column_id` — the column's board, not the task's project, so a
   historically inconsistent pair cannot violate the FK.
4. Drop `tasks.column_id`, `tasks.position`, indexes `tasks_column_id_idx`
   and `tasks_column_id_position_idx`.
5. Drop `projects.board_style`.
6. `CREATE UNIQUE INDEX boards_one_default_per_project ON boards (project_id)
   WHERE is_default;`

Projects created by bootstrap or `createTeamEnvironment` before this lands
have columns, so step 1 covers them. `ensureDefaultBoard` in
`board-structure.ts` (§3.5) keeps the lazy-seed behaviour `getProjectBoard`
had for any project that somehow has no board at all.

Verify on a throwaway pgvector database before opening the PR (the
`nessie-throwaway-pg-migration-check` recipe); step 3's FK is where a bad
assumption would show.

### 3.5 What changes in the shared task modules

`packages/team-admin/src/`:

- `project-structure.ts` → `defaultColumnCreateData` becomes
  `defaultBoardCreateData(organizationId)` returning a nested
  `{ name: 'Board', isDefault: true, position: 0, columns: { create: […] } }`
  used by `createProjectForUser`, bootstrap and `createTeamEnvironment` alike.
- new `board-structure.ts` — `listBoards`, `ensureDefaultBoard`,
  `createBoard` (from defaults or copying another board's columns),
  `updateBoard`, `deleteBoard` (refuses the last board; deleting the default
  requires naming the new default in the same call), column CRUD with
  `stateBindings` validation against the source's known states.
- new `board-placement.ts` — the rule above, `listBoardTasks(prisma, board,
  visibility)` returning `BoardTaskRecord[]` (tasks passing the board filter
  and present on the board, each with resolved `columnId`/`position`; archived
  work (`failed`, `cancelled`, `archivedAt`) is returned with `columnId: null`
  so the existing Archived strip keeps rendering).
- `project-task-move.ts` — `moveProjectTaskToColumn` resolves the column's
  board, checks `board.projectId === task.projectId`, keeps the category →
  status transition and the `in_progress` auto-assign, upserts the placement,
  deletes stale placements on other boards, and reindexes as in §3.3. It gains
  the `writeBack` collaborator in §5.7.
- `project-tasks.ts` — `transitionProjectTask` deletes placements instead of
  nulling `columnId`; `listProjectTasks` orders by `updatedAt desc` only.
- `project-task-records.ts` — `ProjectTaskRecord` loses `columnId` and
  `position`; `BoardTaskRecord = ProjectTaskRecord & { columnId: string |
  null; position: number | null }` is the board read's shape.

`api/src/services/board.ts` is deleted; `api/src/routes/board.ts` is rewritten
against §7.1.

### 3.6 Scrum and iterations

Style is per board. A scrum board shows only the active iteration's tasks,
exactly as `ProjectBoardTab` does today; a kanban board over the same project
shows everything. Iterations, the Backlog tab, Insights and story points stay
project-level, and `ProjectView` shows Backlog/Insights when **any** board of
the project is scrum. "New task" from the header passes `iterationId` only when
the board being viewed is scrum. Nothing about `Iteration` changes.

### 3.7 Board filter

```ts
// packages/schemas/src/boards.ts
export const BoardFilterSchema = z.object({
  sources: z.union([z.literal('all'), z.literal('native'), z.array(z.string().uuid()).min(1)]).default('all'),
  field: z.object({ fieldId: z.string().uuid(), optionIds: z.array(NonEmptyStringSchema).min(1) }).optional(),
}).strict()
```

`sources` selects native tasks, mirrored tasks of named sources, or both;
`field` narrows on one `select`/`multi_select` field. That is the entire
vocabulary. A query builder, swimlanes and group-by are deliberately not built
(§10); the schema is `.strict()` so an unknown key is an error, not a hook.
