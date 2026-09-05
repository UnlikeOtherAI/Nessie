# Project boards: many boards, custom fields, external sources

**Date:** 2026-09-05 · **Status:** built (§12 records the as-built deltas)
**Owning surfaces:** Project → **Board** (`/projects/:projectId/board?board=`),
Project → **Settings** (`/projects/:projectId/settings?section=boards|fields|sources`),
and the per-user **Connections** page for the credentials.
**Supersedes, in part:** [2026-06-11-project-board-settings.md](2026-06-11-project-board-settings.md)
(one board per project, `Project.boardStyle`, `Task.columnId`) — its core
invariant survives unchanged; its storage shape does not.

The owner asked for three things in one sentence: *connect Jira, Linear,
Trello, GitHub Projects or Issues or other systems directly into Projects and
use them as a data source for the project board; custom columns per project
and custom fields; multiple boards per project.* They are one design, because
each constrains the others: an external system can only feed a board if a
board is a **view** over a pool of work rather than a bucket that owns it;
custom fields are what external fields land in; and per-board columns are what
external states map onto.

## 0. The one-paragraph version

A **board is a saved view over its project's task pool**, never a container:
`Board` owns a name, a style, an ordered set of `BoardColumn`s (each still
mapped to one of the four lifecycle categories) and a closed filter; a task's
placement on a given board is a `TaskBoardPlacement` row written only by a
drag, and `Task.status` stays the one lifecycle truth the worker drives. **Custom
fields** are project-scoped definitions with a seven-type vocabulary, stored as
one validated JSONB column on `Task`, keyed by definition id. **External
systems** reach a board as **native provider adapters** in the mould of
`@nessie/comms-connect` — the vendors' own REST/GraphQL, webhooks and delta
cursors through `safeFetch`, never through the MCP servers (whose OAuth tokens
are resource-bound to the MCP endpoint and which have no cursors, no webhooks
and no stable schema). Items are **mirrored into ordinary `Task` rows** with a
`TaskExternalLink`, so agents, assignments, approvals, search, the PA's
`ticket_*` tools and the disclosure sink all work on them unchanged. A source
connects under one person's credential, is `read_only` until a project
administrator flips it, and when `read_write`, a drag writes to the vendor
**synchronously inside the request** and the mirror is rewritten from the
vendor's echo — the same rule the UOA rename follows. A source that stops
working owns how a person finds out, exactly as
[capability-health-alerts.md](../standards/capability-health-alerts.md) says.

## 1. What is true today

Established by reading code, not assumed.

**T1 — one board per project, stored as a style plus a flat column list.**
`Project.boardStyle` (`kanban | scrum`), `BoardColumn { projectId, name,
category, position }`, `Task.columnId` (FK, `SetNull`) and `Task.position`
(`api/prisma/schema.prisma` 1435–1490, 3840–3880). `getProjectBoard`
(`api/src/services/board.ts`) lazily seeds the four default columns; project
creation seeds them through `defaultColumnCreateData` in
`packages/team-admin/src/project-structure.ts`, shared with the Agent
Designer's `project_create`.

**T2 — status is the lifecycle truth; column placement is a pin over it.**
`moveProjectTaskToColumn` (`packages/team-admin/src/project-task-move.ts`)
maps the destination column's category to a `TaskStatus` through
`CATEGORY_TO_STATUS`, validates it against `VALID_TRANSITIONS`, writes
`columnId` + `status` in one transaction, auto-assigns the actor on a move into
`in_progress`, and reindexes positions. The worker only ever writes `status`
(`worker/src/run/execute/lifecycle.ts` `updateTaskStatus`,
`run-suspend.ts` → `awaiting_approval`); it never touches `columnId`.

**T3 — the client resolves placement, and its rule has a latent bug.**
`placeTask` (`admin/src/components/kanban/kanban-config.ts`) returns the pinned
column whenever *that column still exists*, and only falls back to "first column
of the status's category" when there is no valid pin. It does not check that
the pinned column's category still matches the status. A task a person dragged
into *In progress* that an agent run then completes stays rendered in *In
progress* while its status is `done`. §3.3 fixes this as part of generalising
the rule.

**T4 — every board mutation is organisation-owner-gated; task mutations are
member-gated.** `api/src/routes/board.ts` uses `requireOwner` on
`PATCH /board`, `POST/PATCH/DELETE /columns`; `api/src/routes/tasks.ts` uses
`requireUserActor` + `listAccessibleProjectIds`. `ProjectMember.role`
(`owner | admin | member | viewer`) exists, is written as `owner` for the
creator, and gates nothing on the board today.

**T5 — the PA already mirrors the board routes.** `ticket_list / read /
board_read / create / update / assign / move / transition / iteration_set /
archive_done` (`packages/runtime/src/builtin-ticket-tools.ts`,
`worker/src/run/pa-tools/tickets.ts`) call the same `@nessie/team-admin`
functions the routes call, stamp `project:` scopes on the disclosure sink for
non-owners, and are `personalAssistantOnly`. `ticket_board_read` reads
`boardColumn` directly by `projectId`.

**T6 — there is no custom-field concept anywhere.** `customField |
custom_field | fieldValue` have zero hits outside this document.

**T7 — the MCP path cannot be a sync transport.** The curated Linear
(`https://mcp.linear.app/mcp`) and Atlassian (`https://mcp.atlassian.com/v1/sse`)
entries in `packages/mcp-manage/src/library.ts` sign in through dynamic OAuth,
and `mcp-oauth-completion.ts` binds the token to the MCP server URL per
RFC 8707 (`resource` on both legs). That token is not accepted by
`api.linear.app/graphql` or `api.atlassian.com`. `callInstanceTool`
(`mcp-instance-call.ts`) opens one connection per call and closes it.

**T8 — two precedents exist for "somebody else's data, refreshed".**
`@nessie/comms-connect` (per-user OAuth connections, encrypted credential row,
resumable `CommsSyncJob` checkpoints, adapter-declared polling, webhooks at
`/api/comms/webhooks/:provider`, owner-active gate in
`worker/src/control/comms-sync.ts`) and Live Data Dashboards
(`DashboardDataSource` with `authorityUserId`, `accessMode: delegated`,
`nextRunAt/claimedAt` claim, `consecutiveFailures` + capped backoff,
`lastErrorCode` stable codes, `secret_dashboard_*` refs minted once,
`fetchDashboardSource` as the one `safeFetch` chokepoint). §5.12 says which
parts of each this design takes.

**T9 — navigation and design-system facts this design sits on.**
`/projects/:id` and its six section siblings are one `tabHost` identity
(`admin/src/navigation/surfaces.ts` 216–228); sub-strips are `useTabParam`
(`page-types-and-motion.md` §1, host/param table); every single-select strip
is `TabBar`; modals are `Dialog`, drawers `Sheet`; `ProjectPageHeader` already
has an unused `tabs` slot; `ScreenHeader`'s subtitle may carry "a capability
state"; `EmptyState` takes one action slot. `task.updated` is published on the
WS transport but nothing in `admin/` subscribes to it — the board refetches on
mutation.

**T10 — BuildMe already reserved the words.** `BuildMeProjectHandoffIntent`
has `board_source_discovery`, its manifest lists a `project_board` card
"Board source readiness" and a *blocked* `column-mapping` control, and
`push-surface-presence.ts` knows a `project_board` surface. Nothing behind them
exists. This design is what they were waiting for; BuildMe becomes a fifth
adapter in §5.4 when its API exists.

## 2. Decisions at a glance

| Question | Decision | Rejected | Why |
|---|---|---|---|
| A board is a container or a view | **View** over the project's task pool | Container (task belongs to one board) | A container forks the pool per board, breaks the worker's status-driven placement, and makes "Jira board + team board over the same tickets" impossible. Deleting a view deletes no work. |
| Where per-board placement lives | `TaskBoardPlacement (taskId, boardId) → columnId, position` | Keep `Task.columnId` as the default board's pin | A single pin cannot express two `in_progress` columns on two boards. The table is one row per drag, nothing more. |
| `Project.boardStyle` | Moves to `Board.style`; column dropped | Keep as the default board's style | Two answers to one question. |
| `ColumnCategory` | Unchanged; every column on every board maps to one | Free-form columns with a status picker | The four buckets are what the worker, approvals and transitions drive; a board with no column for a category simply does not show that work. |
| Custom-field scope | **Project** | Organisation, board | Org needs inheritance semantics nobody asked for; board-scoped fields vanish when the same task is viewed on another board. |
| Field types | `text number date url select multi_select user` | + `checkbox`, `agent`, `rich_text`, `relation` | Seven cover Jira/Linear/GitHub/Trello's exportable fields; each extra type is a renderer, a validator and a mapping arm. |
| Field storage | One JSONB column `tasks.field_values`, keyed by definition id, GIN-indexed | EAV rows | The board reads whole tasks already; the only server-side filter needed is select-value containment, which GIN serves; EAV adds a table, an include and a reindex per card for no query it uniquely enables at ≤500 cards. |
| Transport to Jira/Linear/Trello/GitHub | **Native adapters** on the vendors' REST/GraphQL via `safeFetch` | MCP connector; vendor SDKs | T7: MCP tokens are resource-bound, MCP has no cursors/webhooks/stable schema, and one connection per call; SDKs use global `fetch`, which the egress lint bans. |
| Sync model | **Mirror into `Task`** + `TaskExternalLink` | Separate `ExternalItem` projected onto the board; live query-through | Everything that already works on `Task` (agents, runs, approvals, search, PA tools, disclosure) works on a mirrored item for free; a second model forks all of it; live query dies with the provider and is unreachable to agents. |
| Write-back | Source-level `writeMode` (`read_only` default, `read_write`); writes are **synchronous in the person's request**, mirror rewritten from the vendor's echo | Async job with local revert; per-field direction matrix | A refused Jira transition must snap the drag back with the reason, not surface a toast a minute later. Per-field matrices are speculative. |
| Agent-initiated external writes | Only through the PA, acting as the person, mirroring the button (no approval gate); unattended runs refuse; the run lifecycle never writes back in v1 | `requiresApproval` on ticket tools | A person's own click has no gate, and the PA mirrors it (personal-assistant-tools.md). The person-controlled gate is `writeMode`. Shared agents have no ticket tools today. |
| State mapping | Source maps external state → **category**; a board column may additionally **bind** specific external states | Per-board state → column mapping only | Category keeps the lifecycle truth board-independent; a binding is what lets "Code review" and "QA" be two Review columns and makes write-back precise. |
| Assignee identity | `BoardSourceIdentityLink (provider tenant, externalUserId) → userId \| agentId`; matched by exact email where the provider exposes it, else manual | Creating local users; storing provider emails | UOA owns identity. A link row is a binding key, the same kind as `User.uoaSub`. |
| Connection scope | Credential is **per person** (`BoardSourceConnection`, org-tenanted); a source is **per project** and names the connection it runs under | Org-wide service credential | Every provider here delegates a human's authority (Jira 3LO, Linear actor=user, Trello user token, GitHub user-to-server); the dashboard precedent already made "fetched under one visible authority" the model. |
| Reuse of Dashboards | Take its **security decisions** (minted refs, visible authority, claim/backoff, stable error codes, one fetch chokepoint), not its tables | Extend `DashboardDataSource` | A dashboard source yields immutable read-only datasets; a board needs mutable, row-identity-preserving, bi-directional mirrors. |
| Board switcher | `TabBar` in `ProjectPageHeader`'s `tabs` slot, driven by `useTabParam('board', …)` | A route per board (`/boards/:boardId`) | Boards are tabs of one screen; the param pattern is the documented one and needs no registry depth. |
| Who administers boards, fields, sources | Org owner **or** `ProjectMember.role ∈ {owner, admin}` via one shared predicate | Keep `requireOwner` | With N boards per project, needing an organisation owner to rename a column is unworkable; the project-owner row already exists. |

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

## 4. Custom fields (B)

### 4.1 Scope: the project

A field definition belongs to a project. It is what "custom fields per project"
means, it is where an external source lands its fields, and it keeps a task's
fields stable across every board of that project. Organisation-level templates
are a later feature with inheritance semantics nobody has asked for.

### 4.2 Types — seven, each justified

| type | value shape in JSON | why it exists | external fields it receives |
|---|---|---|---|
| `text` | string ≤ 2,000 code points | free-form extras a card needs | Jira text fields, Trello text, GitHub Projects text |
| `number` | finite number | estimates, scores, counts | Linear `estimate`, Jira story-point fields, Projects number |
| `date` | `YYYY-MM-DD` | start/target dates beyond the one deadline | Linear target date, Jira date fields, Projects date |
| `url` | `https://` string | design links, PR links | Jira URL fields |
| `select` | option id | issue type, component, team | Jira issue type / component, Projects single-select, Trello list-type fields |
| `multi_select` | option id[] | labels, tags | Jira labels, Linear labels, GitHub labels, Trello labels |
| `user` | Nessie `UserId` | reviewer, reporter | Jira reporter, Linear creator |

Cut, with the reason: `checkbox` (a two-option `select` until a real case
appears), `agent` (the assignee already takes an agent; a second agent field is
speculative), `rich_text` (the task has `detail`), `relation` (a query
language in disguise). Adding a type later is one enum value, one validator
arm in `task-fields.ts` and one renderer arm in `TaskFieldControl`.

### 4.3 Storage — one JSONB column

```prisma
enum TaskFieldType { text number date url select multi_select user }

model TaskFieldDefinition {
  id              String        @id @default(uuid()) @db.Uuid
  projectId       String        @map("project_id") @db.Uuid
  organizationId  String        @map("organization_id") @db.Uuid
  name            String
  type            TaskFieldType
  position        Int
  showOnCard      Boolean       @default(false) @map("show_on_card")
  /// select / multi_select: [{ id, label, tone, retiredAt? }] — ids are stable,
  /// labels mutable, retired options stay readable and leave every picker.
  /// `tone` is the closed Pill tone set (components/primitives/Pill.tsx).
  options         Json          @default("[]")
  /// number: { min?, max?, decimals? }; text: { maxLength? }. Strict per type.
  config          Json          @default("{}")
  createdByUserId String?       @map("created_by_user_id") @db.Uuid
  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")

  project      Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([projectId, name])
  @@index([projectId, position])
  @@map("task_field_definitions")
}
```

`Task.fieldValues Json @default("{}") @map("field_values")` — `{ "<definitionId>":
<value> }`, absent key = no value. Migration
`20260906110000_task_field_definitions/` adds the table, the column and
`CREATE INDEX tasks_field_values_gin ON tasks USING gin (field_values
jsonb_path_ops);`.

**Verdict against EAV**, in the terms asked for:

- *Query/filter/sort.* The only server-side filter is the board's
  `field` clause — `field_values @> '{"<id>": "<optionId>"}'` for `select`,
  `field_values -> '<id>' ? '<optionId>'` for `multi_select` — both served by the
  GIN index. Sorting by a custom number happens in the client over the ≤500
  cards a board renders; no route sorts by a custom field.
- *Validation.* One writer, `updateProjectTask`, validates the patch against the
  definitions before writing (§4.4). EAV would validate the same way; it does
  not buy typed columns because a `select` value is a string either way.
- *Postgres realities.* The board read is `SELECT … FROM tasks` already; JSONB
  adds no join. The merge is one atomic statement,
  `UPDATE tasks SET field_values = (field_values || $patch) - $cleared`,
  through `$executeRaw` exactly as `reindexColumn` already does. Prisma filters
  JSON by `path` + `equals` / `array_contains` on Postgres. A definition delete
  is `UPDATE tasks SET field_values = field_values - '<id>' WHERE project_id = $1`.

EAV would be a table, an `include` on every task read, and a second place to
keep in step with the definition, for no query this scale needs.

### 4.4 Validation and definition changes

`packages/team-admin/src/task-fields.ts`:

- `validateFieldValuesPatch(definitions, patch)` → typed errors
  `FIELD_UNKNOWN`, `FIELD_VALUE_INVALID { fieldId, reason }`; `user` values are
  checked as active organisation members (the `isOrganizationMember` predicate
  `createProjectTask` already uses); `url` must parse as `https:`; `select`
  ids must be non-retired options.
- **A definition's `type` is immutable.** To change a field's type, create a
  new field. Renames are free (values are keyed by id). Options may be added,
  relabelled by id, or retired; retiring never rewrites values.
- Deleting a definition runs the one `UPDATE … - '<id>'` above in the same
  transaction, and refuses while a source mapping targets it
  (`FIELD_IN_USE_BY_SOURCE`, naming the source).

`updateProjectTask` accepts `fields.fieldValues?: Record<string, unknown |
null>` (a partial merge; `null` clears), `PATCH /api/tasks/:taskId` and
`ticket_update` carry it through unchanged.

### 4.5 Rendering

- **Card** (`KanbanCard.tsx`): definitions with `showOnCard` render as `Pill`s
  in a row under the excerpt, at most three, then `+N`; `select` options use
  their `tone`; `user` renders the person's display name through the resolving
  identity primitive, never a hand-assembled tile.
- **TaskDialog**: a new `TaskFieldsSection.tsx` under Deadline in the right
  column — one `FormField` per definition in `position` order, rendered by
  `TaskFieldControl` (`Input`, `Input type=number`, `Input type=date`, `Input
  type=url`, `Select`, a multi-select built on `Popover` + checkboxes,
  `AssigneePicker` with `options` narrowed to people). Values ride in the
  existing `TaskDraft` so a dismissed dialog keeps them.
- **Board**: the filter in §3.7. **Backlog**: no field columns in v1.

### 4.6 The hook external mapping uses

A source's field mapping (§5.8) targets either a native task field
(`native:priority | native:dueDate | native:storyPoints | native:title |
native:detail`) or `field:<definitionId>`. On first connect the adapter's
`describeContainer` lists the external fields, and the attach flow creates a
definition per default mapping the adapter declares (labels → `multi_select
"Labels"`, Jira issue type → `select "Type"`, Linear estimate → `number
"Estimate"`), reusing an existing definition of the same name and type rather
than duplicating it.

## 5. External systems as a board data source (C)

### 5.1 Transport verdict — per provider

Every provider is a **native adapter** speaking the vendor's own API through
`@nessie/runtime` `safeFetch`, with the vendor's real webhooks and delta
mechanism. No vendor SDK (they call global `fetch`, which the root
`eslint.config.js` egress block bans), no MCP.

| Provider | Auth (deployment ↔ person) | Read API + delta | Webhooks | Write-back | State model → category default |
|---|---|---|---|---|---|
| **Jira Cloud** | OAuth 2.0 (3LO): app registered per deployment (`NESSIE_BOARD_JIRA_CLIENT_ID/SECRET`); scopes `read:jira-work write:jira-work read:jira-user offline_access`; rotating refresh tokens; `accessible-resources` → `cloudId` per site | `GET https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/search/jql?jql=…&nextPageToken=…&maxResults=100` (the pre-2025 `/search` is retired); delta = `updated >= <since>` ordered by updated with a 5-minute overlap; `GET /project/{key}/statuses`, `/field`, `/user/search` | `POST /rest/api/3/webhook` (`jira:issue_created/updated/deleted`, JQL-scoped); **expire after 30 days**, `PUT /webhook/refresh`; max 100 per app; **unsigned** → per-source URL token (§5.6) | Status only via `GET /issue/{key}/transitions` + `POST …/transitions {transition:{id}}` — a category change becomes "find a transition whose target is the bound/default state"; assignee `PUT /issue/{key}/assignee {accountId}`; fields `PUT /issue/{key}` | `statusCategory.key`: `new → todo`, `indeterminate → in_progress`, `done → done`; nothing maps to `review` until a person promotes a state |
| **Linear** | OAuth 2.0: per-deployment app (`NESSIE_BOARD_LINEAR_CLIENT_ID/SECRET`), `scope=read,write`, `actor=user`; tokens long-lived until revoked (refresh if the app is configured for expiring tokens) | GraphQL `https://api.linear.app/graphql`: `issues(filter:{team:{id:{eq}}, updatedAt:{gt}}, first:100, after, orderBy: updatedAt)` with `state{id,name,type}`, `assignee{id,name,email}`, `labels`, `priority`, `estimate`, `dueDate` | OAuth-app webhooks (configured once on the app, fire for every authorised workspace; `Linear-Signature` HMAC-SHA256 of the raw body, `webhookTimestamp` ≤ 60 s) — verify at build time (§11); adapter declares 5-minute polling as the fallback | `issueUpdate(id, {stateId, assigneeId, title, description, priority, dueDate, labelIds, estimate})` | `state.type`: `triage/backlog/unstarted → todo`, `started → in_progress`, `completed → done`, `canceled → archived`; a `started` state named for review is promoted by a person |
| **Trello** | Power-Up API key + secret per deployment (`NESSIE_BOARD_TRELLO_API_KEY/SECRET`); person authorises at `https://trello.com/1/authorize?scope=read,write&expiration=never&response_type=token…`; the token arrives in the URL fragment and is submitted **once** to `POST …/trello/complete` → encrypted | `GET /1/boards/{id}/lists`, `GET /1/boards/{id}/cards?customFieldItems=true&members=true`; no `since` on cards → poll re-reads open cards + `dateLastActivity` (fine at ≤1,000 cards); `GET /1/boards/{id}/actions?since=` for deletes | `POST /1/webhooks {callbackURL, idModel: boardId}`; Trello sends a **HEAD** first; `x-trello-webhook` = base64(HMAC-SHA1(body + callbackURL, secret)) | `PUT /1/cards/{id}?idList=`; `PUT …?idMembers=`; custom field items | Lists are states: first list → `todo`, last → `done`, others → `in_progress`; `closed` card → `archived` |
| **GitHub Issues** | **GitHub App** per deployment (`NESSIE_BOARD_GITHUB_APP_ID/PRIVATE_KEY/CLIENT_ID/CLIENT_SECRET/WEBHOOK_SECRET`); the person connects with user-to-server OAuth (8-hour tokens + refresh), which proves which installations they may attach; sync uses a 1-hour **installation token** minted from the app JWT | `GET /repos/{o}/{r}/issues?state=all&since=&sort=updated&direction=asc&per_page=100` (rows with `pull_request` dropped) | App webhook `issues` (+ `label`), `X-Hub-Signature-256`, `X-GitHub-Delivery` for idempotency | `PATCH /repos/{o}/{r}/issues/{n} {state, state_reason, title, body, labels, assignees}`; assignees must be collaborators | `open → todo`; `closed + completed → done`; `closed + not_planned → archived`; `in_progress`/`review` only via a bound label or a Projects v2 status |
| **GitHub Projects v2** | Same App; org permission **Projects: read & write**; same user-to-server link | GraphQL only: `node(id) { … on ProjectV2 { items(first:100, after) { nodes { id updatedAt content{…} fieldValues(first:20){…} } } } }`; delta by `updatedAt` per item | App webhook `projects_v2_item` (created/edited/reordered/converted/archived/deleted) | `updateProjectV2ItemFieldValue({projectId, itemId, fieldId, value:{singleSelectOptionId}})` — the `Status` field is the state; text/number/date/single-select fields map 1:1 to §4.2 | `Status` options: first → `todo`, last → `done`, others → `in_progress`; archived item → `archived` |

Rate limits (Jira dynamic 429 + `Retry-After`; Linear complexity budget;
GitHub 5,000/h per installation; Trello 300/10 s per key) are handled by one
`rate_limited` transient in the sync engine (§5.10), never by a provider branch
in the worker.

### 5.2 Why MCP is the wrong shape for sync — said plainly

The existing MCP connectors for Linear and Atlassian stay exactly as they are,
for what they are good at: an agent *talking to* Linear or Jira in a run —
searching, commenting, creating an issue conversationally. They are not a sync
transport, for four reasons that are facts rather than taste:

1. **The token cannot reach the vendor API.** T7: dynamic OAuth binds the
   token to `https://mcp.linear.app/mcp` (RFC 8707). Using it against
   `api.linear.app` fails. So "the user already signed in" buys nothing for a
   sync path.
2. **No cursors, no webhooks.** MCP tools are request/response. Keeping 2,000
   issues fresh means re-listing them, and there is no way to be told about a
   change.
3. **No stable schema.** Tool names and argument shapes are the vendor's to
   change without notice; a sync needs deterministic parsing and idempotent
   upserts keyed on stable ids.
4. **One connection per call** (`callInstanceTool` opens and closes). A
   first sync would open thousands.

A board source therefore never touches `McpServerInstance`. Where an App Store
row exists for the same vendor, the two are two install modes of one app (§6.6).

### 5.3 Sync model — mirror into `Task`

An external item becomes an ordinary `Task` row in the project, plus a
`TaskExternalLink` row carrying the external identity, the last-seen remote
state and the fingerprints echo suppression needs. Defended against the
alternatives on the axes asked for:

- **Board performance.** The board read is the existing task read with a join
  on a one-row link. No fan-out, no second store.
- **Degraded provider.** The board keeps rendering the mirror; the source's
  health state (§5.10) says how old it is. Live query-through would render an
  empty board.
- **Agents.** `Task.runId`, `assigneeAgentId`, `ApprovalRequest.taskId`,
  `UserAlert.taskId`, `WorkflowStepRun`, the PA's `ticket_*` tools — all keyed
  on `Task`. An agent can be assigned a Jira ticket exactly as a native task and
  the run lifecycle drives its status. A separate `ExternalItem` store would
  need every one of those re-implemented or bridged — the fork Rule zero names.
- **Search/filter.** `GET /api/tasks` filters, the board filter, and the
  attention summary all work unchanged.
- **Disclosure.** A mirrored task is project-scoped; the `ticket_*` reads
  already stamp `project:` for non-owners. The sync worker is not a run and
  reads nothing into a context. External **comments are not imported** in v1
  precisely because an upstream comment can have a narrower audience than the
  issue, and importing it would need its own basis.

### 5.4 Package layout — the `comms-connect` mould

```
packages/board-sources/            @nessie/board-sources   (core, no Prisma)
  src/adapter.ts                   BoardSourceAdapter contract (below)
  src/registry.ts                  registerBoardSourceAdapter / resolveBoardSourceAdapter
  src/items.ts                     NormalisedItem, OutboundChange, itemFingerprint()
  src/oauth-state.ts               state payload shape (mirrors comms)
  src/errors.ts                    SourceRejectedError { code, detail }, SourceAuthError, SourceRateLimitedError
  src/webhook.ts                   WebhookRequest, verification helpers (HMAC-SHA256/SHA1, timing-safe)
packages/board-source-jira/        @nessie/board-source-jira
packages/board-source-linear/      @nessie/board-source-linear
packages/board-source-trello/      @nessie/board-source-trello
packages/board-source-github/      @nessie/board-source-github  (issues + projects v2 containers)
packages/board-source-providers/   @nessie/board-source-providers — registerBoardSourceAdaptersFromEnv()
```

One package per provider, as comms does, so vendor-specific parsing stays under
the 500-line cap per file and an unconfigured provider is simply not
registered — the picker never offers it and its jobs park on
`AdapterNotRegisteredError`. Registration happens at API and worker startup
from `NESSIE_BOARD_*` env, beside `registerCommsConnectorsFromEnv`.

```ts
// packages/board-sources/src/adapter.ts
export interface BoardSourceAdapter {
  readonly provider: BoardSourceProvider
  readonly incrementalPollingIntervalMs?: number       // declared fallback when webhooks are absent
  oauth: {
    buildAuthorizeUrl(input: { state: string; redirectUri: string; codeChallenge?: string }): string
    exchange(input: OAuthExchangeInput): Promise<ConnectResult>      // { externalAccountId, externalTenantId, credential, grantedScopes }
    refresh(credential: CredentialBundle): Promise<CredentialBundle>
  }
  listContainers(ctx: ConnectionContext): Promise<ContainerDescriptor[]>          // Jira projects, Linear teams, Trello boards, GitHub repos + projects
  describeContainer(ctx, container): Promise<ContainerDescription>             // { states, fields, members }
  fetchPage(ctx, container, checkpoint: SyncCheckpoint): Promise<SyncPage>       // initial and incremental, by checkpoint
  fetchItems(ctx, container, externalIds: string[]): Promise<NormalisedItem[]>  // after a webhook that carries ids only
  ensureWebhook(ctx, container, callback: { url: string; token: string }): Promise<WebhookRegistration | null>
  verifyWebhook(request: WebhookRequest, secrets: WebhookSecrets): boolean
  parseWebhook(request: WebhookRequest): WebhookDelivery                        // { deliveryId, containerKey, items | externalIds }
  applyChange(ctx, container, item: NormalisedItem, change: OutboundChange): Promise<NormalisedItem>  // returns the vendor's echo
}

export type NormalisedItem = {
  externalId: string; externalKey: string; url: string
  title: string; description: string | null
  stateId: string; stateName: string
  assignee: { externalUserId: string; displayName: string; email?: string } | null
  priority: string | null                    // provider raw, mapped by the source
  dueDate: string | null                     // YYYY-MM-DD
  labels: { id: string; label: string }[]
  fields: Record<string, unknown>            // by external field key
  createdAt: string; updatedAt: string
  archived: boolean                          // deleted, trashed, cancelled upstream
}
```

`itemFingerprint(item, mapping)` hashes only the **mapped** fields, in mapping
order — it is what echo suppression compares (§5.7).

### 5.5 Model

```prisma
enum BoardSourceProvider { jira linear trello github }
enum BoardSourceConnectionStatus { active needs_reauthorization revoked }
enum BoardSourceWriteMode { read_only read_write }
enum BoardSourceHealth { active paused needs_reauthorization owner_inactive misconfigured error }

/// One person's delegated authority at one provider, reusable across projects.
model BoardSourceConnection {
  id                String                      @id @default(uuid()) @db.Uuid
  organizationId    String                      @map("organization_id") @db.Uuid
  ownerUserId       String                      @map("owner_user_id") @db.Uuid
  provider          BoardSourceProvider
  /// The provider's stable account id: Atlassian accountId, Linear user id,
  /// Trello member id, GitHub user id. Never a display name, never an email.
  externalAccountId String                      @map("external_account_id")
  /// Linear organisation id, GitHub installation id; empty for Jira (a 3LO
  /// token spans sites — the container carries the cloudId) and Trello.
  externalTenantId  String                      @default("") @map("external_tenant_id")
  status            BoardSourceConnectionStatus @default(active)
  grantedScopes     Json                        @default("[]") @map("granted_scopes")
  lastVerifiedAt    DateTime?                   @map("last_verified_at")
  createdAt         DateTime                    @default(now()) @map("created_at")
  updatedAt         DateTime                    @updatedAt @map("updated_at")

  organization Organization                     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  owner        User                             @relation("BoardSourceConnectionOwner", fields: [ownerUserId], references: [id], onDelete: Cascade)
  credential   BoardSourceConnectionCredential?
  sources      BoardSource[]

  @@unique([organizationId, ownerUserId, provider, externalAccountId, externalTenantId])
  @@index([organizationId, ownerUserId])
  @@map("board_source_connections")
}

/// Encrypted with the same `credential-crypto` seam comms uses. Never read by
/// any route; decrypted only in `loadBoardSourceCredential` (@nessie/team-admin).
model BoardSourceConnectionCredential {
  id                     String    @id @default(uuid()) @db.Uuid
  connectionId           String    @unique @map("connection_id") @db.Uuid
  accessTokenCiphertext  String    @map("access_token_ciphertext")
  refreshTokenCiphertext String?   @map("refresh_token_ciphertext")
  expiresAt              DateTime? @map("expires_at")
  keyVersion             Int       @default(1) @map("key_version")
  createdAt              DateTime  @default(now()) @map("created_at")
  updatedAt              DateTime  @updatedAt @map("updated_at")
  connection BoardSourceConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  @@map("board_source_connection_credentials")
}

/// Single-use OAuth state bound to (user, provider, organization); mirrors
/// `CommsOAuthState`. Carries PKCE, `targetConnectionId` on re-authorization,
/// and `expectedAccountId` so a re-auth cannot re-point to another account.
model BoardSourceOAuthState {
  token          String              @id
  organizationId String              @map("organization_id") @db.Uuid
  userId         String              @map("user_id") @db.Uuid
  provider       BoardSourceProvider
  payload        Json
  expiresAt      DateTime            @map("expires_at")
  createdAt      DateTime            @default(now()) @map("created_at")
  @@map("board_source_oauth_states")
}

/// One external container (Jira project, Linear team, Trello board, GitHub
/// repo or Projects v2 board) feeding one Nessie project.
model BoardSource {
  id               String               @id @default(uuid()) @db.Uuid
  projectId        String               @map("project_id") @db.Uuid
  organizationId   String               @map("organization_id") @db.Uuid
  connectionId     String               @map("connection_id") @db.Uuid
  provider         BoardSourceProvider
  name             String                                       // "Jira · PROJ", editable
  /// Provider-specific, validated by the adapter's ContainerSchema:
  /// jira { cloudId, projectKey, jql? } · linear { teamId } · trello { boardId }
  /// · github { kind: 'repository', owner, repo } | { kind: 'project', ownerLogin, projectNumber, nodeId }
  container        Json
  /// Adapter-computed canonical string of `container`, for the unique key.
  containerKey     String               @map("container_key")
  writeMode        BoardSourceWriteMode @default(read_only) @map("write_mode")
  /// [{ externalStateId, externalStateName, category: ColumnCategory | 'archived' | null, isDefaultForCategory }]
  stateMapping     Json                 @default("[]") @map("state_mapping")
  /// [{ externalKey, externalLabel, externalType, target: 'native:priority' | … | 'field:<id>', valueMap?: Record<string,string> }]
  fieldMappings    Json                 @default("[]") @map("field_mappings")
  /// Done/archived items older than this are not imported on the first sync.
  syncWindowDays   Int                  @default(30) @map("sync_window_days")

  healthState         BoardSourceHealth @default(active) @map("health_state")
  /// Stable code, never an upstream message; the surface explains from it.
  healthReason        String?           @map("health_reason")
  healthDetail        String?           @map("health_detail")
  healthRevision      Int               @default(0) @map("health_revision")
  lastSyncStartedAt   DateTime?         @map("last_sync_started_at")
  lastSyncCompletedAt DateTime?         @map("last_sync_completed_at")
  lastErrorCode       String?           @map("last_error_code")
  consecutiveFailures Int               @default(0) @map("consecutive_failures")
  nextRunAt           DateTime?         @map("next_run_at")
  claimedAt           DateTime?         @map("claimed_at")
  /// SyncCheckpoint — { cursor?, since?, phase: 'initial' | 'incremental' }
  checkpoint          Json              @default("{}")

  webhookExternalId String?   @map("webhook_external_id")
  webhookExpiresAt  DateTime? @map("webhook_expires_at")
  /// SHA-256 of the per-source URL token, for providers that do not sign (Jira).
  webhookTokenHash  String?   @map("webhook_token_hash")

  createdByUserId String   @map("created_by_user_id") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  project      Project               @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organization Organization          @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  connection   BoardSourceConnection @relation(fields: [connectionId], references: [id], onDelete: Restrict)
  links        TaskExternalLink[]
  healthAlerts UserAlert[]           @relation("BoardSourceHealthAlert")

  @@unique([projectId, provider, containerKey])
  @@index([nextRunAt, claimedAt])
  @@index([organizationId, healthState])
  @@map("board_sources")
}

model TaskExternalLink {
  id                       String    @id @default(uuid()) @db.Uuid
  organizationId           String    @map("organization_id") @db.Uuid
  taskId                   String    @unique @map("task_id") @db.Uuid
  sourceId                 String    @map("source_id") @db.Uuid
  externalId               String    @map("external_id")
  externalKey              String    @map("external_key")        // "PROJ-123", "ENG-42", "#17"
  externalUrl              String    @map("external_url")
  remoteStateId            String?   @map("remote_state_id")
  remoteStateName          String?   @map("remote_state_name")
  /// Provider display data for an assignee no identity link resolves. Not a
  /// person record: it is what the card shows as "J. Doe (Jira)".
  remoteAssigneeExternalId String?   @map("remote_assignee_external_id")
  remoteAssigneeDisplay    String?   @map("remote_assignee_display")
  externalUpdatedAt        DateTime? @map("external_updated_at")
  remoteDeletedAt          DateTime? @map("remote_deleted_at")
  inboundFingerprint       String?   @map("inbound_fingerprint")
  outboundFingerprint      String?   @map("outbound_fingerprint")
  lastInboundAt            DateTime? @map("last_inbound_at")
  lastOutboundAt           DateTime? @map("last_outbound_at")
  createdAt                DateTime  @default(now()) @map("created_at")
  updatedAt                DateTime  @updatedAt @map("updated_at")

  task   Task        @relation(fields: [taskId], references: [id], onDelete: Cascade)
  source BoardSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)

  @@unique([sourceId, externalId])
  @@map("task_external_links")
}

/// The only place a provider identity meets a Nessie identity. Scoped to the
/// provider tenant, not the source, so one mapping serves every project.
model BoardSourceIdentityLink {
  id                  String              @id @default(uuid()) @db.Uuid
  organizationId      String              @map("organization_id") @db.Uuid
  provider            BoardSourceProvider
  /// Jira cloudId, Linear organisation id, 'trello', 'github'.
  externalTenantKey   String              @map("external_tenant_key")
  externalUserId      String              @map("external_user_id")
  externalDisplayName String?             @map("external_display_name")
  userId              String?             @map("user_id") @db.Uuid
  agentId             String?             @map("agent_id") @db.Uuid
  matchedBy           String              @map("matched_by")            // 'email' | 'manual'
  createdByUserId     String?             @map("created_by_user_id") @db.Uuid
  createdAt           DateTime            @default(now()) @map("created_at")
  updatedAt           DateTime            @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user         User?        @relation(fields: [userId], references: [id], onDelete: Cascade)
  agent        Agent?       @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@unique([organizationId, provider, externalTenantKey, externalUserId])
  @@map("board_source_identity_links")
}
```

`Task` gains `externalLink TaskExternalLink?`. `UserAlertKind` gains
`board_source_health`; `UserAlert` gains `boardSourceId` with the
`BoardSourceHealthAlert` relation. Migration
`20260906120000_board_sources/`. A `CHECK` on `board_source_identity_links`
requires exactly one of `user_id` / `agent_id`, or neither (an unmatched
provider identity a person has seen and left unmapped).

Under the UOA rule: no row here holds a person's email, name or avatar as
Nessie identity. `externalDisplayName` and `remoteAssigneeDisplay` are the
provider's own data about the provider's own user, kept so the mapping table
and the card can name who is unmapped; `userId` is a binding key of the same
kind as `User.uoaSub`. Nothing here is ever promoted to a `User`.

### 5.6 Inbound sync

Topics in `packages/schemas/src/board-sources.ts`, handlers in
`worker/src/control/board-source-sync.ts` and `board-source-webhook.ts`:

| topic | payload | what it does |
|---|---|---|
| `board-source.sync.initial` | `{ sourceId }` | `describeContainer` → seed default mappings if empty → page through `fetchPage` from an empty checkpoint, ≤100 pages per job, persisting the checkpoint after every page (resumable) → `ensureWebhook` → `healthState: active`, `nextRunAt` |
| `board-source.sync.incremental` | `{ sourceId }` | `fetchPage` from the stored checkpoint; on `SourceCursorExpiredError` reset to a bounded re-sync (the comms `resetJobForBoundedResync` shape) |
| `board-source.sync.sweep` | `{ bucket }` | periodic: claim sources with `nextRunAt <= now() AND claimed_at IS NULL` by a single conditional UPDATE, enqueue incremental — the trigger poller's claim shape, no second scheduler |
| `board-source.webhook.process` | `{ provider, deliveryId, sourceId?, headers, body }` | `verifyWebhook` → `parseWebhook` → `fetchItems` when the payload carries ids only → apply; idempotent on `deliveryId` |
| `board-source.webhooks.renew` | `{ withinMs }` | re-registers webhooks expiring inside the window (Jira's 30 days); mirrors `comms.subscriptions.renew` |

Intake route: `POST /api/board-sources/webhooks/:provider/:token?` (public,
`HEAD` answered 200 for Trello), which does nothing but enqueue — verification
happens in the worker with the deployment secret and, for Jira, the source's
`webhookTokenHash`. Same split comms uses.

**Applying an item** — `applyInboundItem(prisma, source, item)` in
`packages/team-admin/src/board-source-apply.ts` (Prisma-aware and shared,
because the API applies the vendor's echo on a write-back, §5.7):

1. `fingerprint = itemFingerprint(item, source)`. If it equals
   `link.outboundFingerprint` → this is our own write coming back: advance
   `externalUpdatedAt`/`lastInboundAt`, write no `TaskEvent`, publish nothing.
   If it equals `link.inboundFingerprint` → nothing changed on a mapped field;
   same treatment.
2. Otherwise upsert the task: `title`, `detail` (description), `priority`
   through the mapping's `valueMap`, `dueDate`, `assigneeUserId`/
   `assigneeAgentId` through the identity link (or `null` + the link's
   `remoteAssignee*`), `fieldValues` for every mapped field (unmapped Nessie
   fields untouched), `status` from the state mapping.
3. **Status bypasses `VALID_TRANSITIONS`** — the vendor is the authority for
   its own item — and writes a `status_changed` `TaskEvent` with
   `{ bySourceId, from, to, remoteStateId }`. `todo` becomes `assigned` when an
   assignee resolved, else `inbox`; `archived` becomes `cancelled` +
   `archivedAt`. A state with no mapping leaves `status` untouched and moves
   the source to `misconfigured` with `healthReason: 'UNMAPPED_STATE'`,
   `healthDetail: <state name>` (a person maps it; §5.10).
4. Publish `board.updated { projectId }` (§7.4) once per job, not per item.

Initial import bounds: every non-done item in the container plus
done/archived items updated within `syncWindowDays`. A Jira project with
40,000 resolved issues is why the default is 30 days.

### 5.7 Write-back

`writeMode` is per source and defaults to `read_only`. Authority per field is
then a consequence, not a matrix:

- **Source-owned fields** are the mapped ones: state, title, detail, assignee,
  priority, due date, and every mapped custom field. In `read_only` a person
  may pin and reorder a mirrored card within its category, and edit every
  Nessie-only field (unmapped custom fields, story points unless mapped,
  iteration, owner), but a category-changing move, a title edit, or an
  assignment is refused with `409 SOURCE_READ_ONLY` and copy that names the
  remedy: *"Jira owns this ticket's status. Switch the source to read & write
  in Settings → Sources to move it from here."*
- **In `read_write`** the same actions call the adapter **before** the local
  transaction. `moveProjectTaskToColumn`, `updateProjectTask` and
  `assignProjectTask` take an injected `writeBack: BoardSourceWriteBack` —
  `{ apply(link, change): Promise<NormalisedItem> }` built by the API from the
  registry and by the worker identically — and on success apply the vendor's
  echo through `applyInboundItem` in the same transaction as the placement,
  stamping `outboundFingerprint = itemFingerprint(echo)`. The mirror is
  written from the echo, never from the request (the UOA rename rule).
- **Refusal is synchronous.** `SourceRejectedError { code, detail }` becomes
  `409 SOURCE_REJECTED` and the drag snaps back with the reason
  (`JIRA_NO_TRANSITION` "PROJ-123 has no transition to *Done* from *In Review*";
  `ASSIGNEE_NOT_LINKED` "Alice isn't linked to a Jira account — link her in
  Settings → Sources → Jira → People"). No async revert, no toast a minute
  later. Provider calls run under the dashboard fetch envelope: 10 s, `safeFetch`,
  `maxRedirects: 0`.
- **Which external state a move writes:** the destination column's
  `stateBindings` entry for this source if it has one, else the source
  mapping's `isDefaultForCategory` state. Jira additionally resolves a
  transition whose target is that state; none → `JIRA_NO_TRANSITION`.
- **Conflicts.** Inbound applies only when the item's fingerprint differs from
  both stored fingerprints (§5.6); outbound is synchronous and re-reads the
  echo. Because a local edit to a mapped field is only possible through a
  successful write-back, local and remote cannot diverge on a mapped field by
  construction; there is no merge to do.
- **Agents.** The PA's `ticket_move` / `ticket_update` / `ticket_assign` call
  the same functions with the same collaborator and get the same refusals in
  words, acting as the person — the button has no approval gate, so the tool
  mirrors it (personal-assistant-tools.md). Unattended runs have no acting
  member and already refuse. The run lifecycle (`updateTaskStatus`) does
  **not** write back in v1; §10 records the hook.

### 5.8 Mapping

Configured on the source's page in Project → Settings → Sources, by a project
administrator; seeded on attach from the adapter's `describeContainer` so the
first sync is right without configuration.

- **State → category** (`stateMapping`): a table of the container's states,
  each with a category picker (`To do / In progress / Review / Done /
  Archived / Not mapped`) and a "default for this category" radio. Defaults
  come from the provider's own type where it has one (Jira `statusCategory`,
  Linear `state.type`, GitHub `state` + `state_reason`) and from list order
  where it does not (Trello, Projects v2 `Status`). `review` starts empty
  everywhere — nothing guesses a state's meaning from its name; a person
  promotes it.
- **Column state bindings** (`BoardColumn.stateBindings`): in the Boards
  section, a column's row offers "Shows external states…" listing the states
  of every source in the project whose mapped category equals the column's.
  A bound column places items in those states (§3.3) and writes back to the
  first bound state (§5.7). Unbound columns keep category behaviour.
- **Assignee → person or agent** (`BoardSourceIdentityLink`): a People table
  of the container's members with the resolved Nessie identity. Auto-match on
  **exact email equality** against `User.email` of an active member, where the
  provider exposes email (Jira with `read:jira-user`, subject to the account's
  privacy setting; Linear; GitHub only when public; Trello never) — a read of
  UOA-mirrored data, not a store of provider data; the mapping row records
  `matchedBy: 'email'`. Everything else is manual through the same
  `AssigneePicker`, which also lets a provider bot user map to a Nessie
  **agent** so an agent assignee writes back as that bot.
- **Priority → `Task.priority`**: a fixed per-provider `valueMap` in the
  adapter (Jira Highest/High → `urgent`/`high`, Medium → `medium`, Low/Lowest
  → `low`; Linear 1→`urgent`, 2→`high`, 3→`medium`, 4→`low`, 0→`medium`),
  editable on the Fields table.
- **Labels, types, estimates, dates → custom fields** (`fieldMappings`): the
  Fields table lists external fields with a target picker — a native field, an
  existing definition of a compatible type, or *Create field*. Defaults per
  §4.6.

### 5.9 Identity and tenancy

- A **connection** is one person's delegated authority at one provider, tenanted
  to the organisation. Anyone may create one for themselves. It appears on
  their **Connections** page (`/settings/connections`, the existing per-user
  connections surface) under a *Project tools* group, with Reconnect and
  Remove.
- A **source** is per project, created by a project administrator **who owns
  the connection it names**. An org owner may not attach somebody else's
  connection: that would run a sync under a credential its owner never pointed
  at that project. `PATCH …/sources/:id { connectionId }` is restricted the
  same way and is the "Connect as me" remedy.
- Sync runs under the connection owner's credential. When that person is
  deactivated, the sweep skips the source (the comms `isConnectionOwnerActive`
  gate) **and** transitions it to `owner_inactive` — the comms precedent skips
  silently, which is the defect the health standard was written after. Remedy:
  another administrator connects and takes it over.
- Removing a connection that sources still name is refused
  (`CONNECTION_IN_USE`, naming the projects); the person pauses or re-points
  those sources first.

### 5.10 Health — every state names its remedy

| `healthState` | Meaning | Remedy the surface shows | Alert |
|---|---|---|---|
| `active` | syncing; `lastSyncCompletedAt` is the freshness | — | — |
| `paused` | a person paused it | **Resume** | — |
| `needs_reauthorization` | the provider rejected the credential (401/403 not caused by a permission) | **Reconnect** (starts OAuth bound to the connection) | once |
| `owner_inactive` | the connection owner is no longer an active member | **Connect as me** | once |
| `misconfigured` | `UNMAPPED_STATE`, `CONTAINER_GONE`, `FIELD_GONE`, `WEBHOOK_REGISTRATION_FAILED` | **Edit mapping** → the offending row highlighted | once |
| `error` | anything else, with `lastErrorCode` (`SOURCE_TIMEOUT`, `SOURCE_HTTP_ERROR`, …) after backoff exhausted (six hours) | **Retry now** | once |

Transient `429`/`5xx` set `consecutiveFailures` and `nextRunAt` by the capped
exponential backoff `dashboard-refresh.ts` uses and change no health state; the
board's freshness pill simply ages. The transition is claimed by the single
conditional UPDATE that bumps `healthRevision`; the same statement's success is
what enqueues `board-source.health-alert`, which writes one `UserAlert
(kind: board_source_health, eventKey: 'board-source-health:<sourceId>:<revision>')`
per recipient — the project's owners/admins, the organisation's owners and the
connection owner — under the existing `(user_id, event_key)` uniqueness, and
pushes under a new `pushBoardSourceHealth` preference with a generic body. The
alert is revalidated on read (`visibleUserAlertWhere`) so it disappears when the
source is healthy again. Recovery is explicit — the buttons above — and never
happens at login.

### 5.11 Egress and disclosure

Every provider call goes through `safeFetch` with a per-adapter origin
allowlist (`api.atlassian.com`, `auth.atlassian.com`, `api.linear.app`,
`api.trello.com`, `api.github.com`, `github.com`), `maxRedirects: 0` whenever a
credential is attached, a 1 MiB response cap and `Accept-Encoding: identity`
— the `fetchDashboardSource` envelope, relocated into
`packages/board-sources/src/http.ts` as `sourceFetch` so both engines call one
function. Vendor SDKs are not used (they bypass the lint's ratchet). OAuth
exchanges follow `mcp-oauth-completion.ts`: PKCE where the provider supports
it, state single-use and TTL-bound, `expectedAccountId` on re-authorisation.

Disclosure: a mirrored task carries no basis of its own; the reads that put it
into a run's context are the existing `ticket_*` tools, which stamp `project:`
for non-owners already. The one new read, `ticket_fields_read`, stamps the
same scope. Comments stay out (§5.3).

### 5.12 What this takes from Dashboards, and what it does not

Taken verbatim, because they are security decisions rather than features:
plaintext credentials submitted once and minted to a server-side ref (here the
encrypted credential row; the only plaintext path is Trello's one-shot token
POST); a visible source authority (`connection.ownerUserId`) whose access every
viewer of the project sees through; the `nextRunAt/claimedAt` claim, capped
backoff, `consecutiveFailures` and stable `lastErrorCode`; one network
chokepoint; loopback denial. Not taken: `DashboardDataSource`, datasets,
JMESPath, output columns. A dashboard source produces an immutable read-only
table with no row identity and no write path; a board source produces mutable,
identity-preserving, bi-directional mirrors. Extending the dashboard tables
would have meant three forks — a write path, row identity and webhooks — inside
a model built to have none.

## 6. Surfaces (D)

### 6.1 Owning surface and doorways

| Capability | Owning surface | In-context doorways |
|---|---|---|
| Boards | `/projects/:id/board?board=<boardId>` — `BoardSwitcher` (`TabBar`, `role="tablist"`) in `ProjectPageHeader`'s `tabs` slot | header overflow **New board…**, **Board settings…**; Overview → Work section lists every board (`Board · Dev board · Jira board`) instead of one link |
| Columns | `/projects/:id/settings?section=boards&board=<id>` (`BoardsSettingsSection`) | column header menu **Edit columns** (administrators) |
| Custom fields | `/projects/:id/settings?section=fields` (`FieldsSettingsSection`) | `TaskDialog` Fields section → **Manage fields…** (administrators); card chips |
| Sources | `/projects/:id/settings?section=sources[&source=<id>]` (`SourcesSettingsSection`, `SourceMappingPanel`) | board empty state **Connect a source**; header overflow **Connect a source…**; `SourceStatusStrip` pills under the board header; the bell (`board_source_health`) → the source with its remedy; `/apps/:slug` **Use as a project board source**; Overview → Work section line *"Jira needs reconnecting →"* |
| Connections | `/settings/connections` → *Project tools* group | Sources section **Connect** (creates or reuses the caller's connection) |

### 6.2 The Board tab with N boards

`ProjectView` passes `tabs={<BoardSwitcher projectId boards />}` to
`ProjectPageHeader` when `tab === 'board'`. `BoardSwitcher` is the shared
`TabBar` with one item per board in `position` order, driven by
`useTabParam('board', boardIds, defaultBoardId)` — linkable, refresh-safe,
never a history entry; an unknown or absent `?board=` reads as the default
board, so an old bookmark degrades to the board the project opens on. The
host/param table in `docs/navigation/page-types-and-motion.md` §1 and
`admin/test/tab-param.test.ts` gain the row:

| host | param | values |
| a project board (`ProjectBoardTab`) | `board` | one per board of the project (default: the project's default board) |

Under the header, when the project has sources: `SourceStatusStrip` — one
`Pill` per source, `Jira PROJ · synced 2 min ago` in the neutral tone, or the
health state's label in `warning`/`danger` with the remedy verb, linking to the
source's settings page. It answers "is what I am looking at current?", which is
the decision a person makes before dragging.

`KanbanBoard` is unchanged in shape: it receives the board's columns and
`BoardTaskRecord[]` (already placed by the server) and only groups by
`columnId`. `placeTask` and `statusToCategory` leave `kanban-config.ts`.

### 6.3 Settings

`ProjectSettingsPage` (297 lines today) becomes a host of three sections
selected by `useTabParam('section', ['boards','fields','sources'], 'boards')`
rendered as a `TabBar` at the top of the `PageBody`, each section its own file:

- `admin/src/pages/project/settings/BoardsSettingsSection.tsx` — a `RowList`
  of boards (name, style pill, default marker, column count; **Delete** refuses
  the last board and asks which board becomes default when deleting the
  default); **New board** opens `BoardCreateDialog` (`Dialog`: name, style,
  *Start with the default columns* / *Copy columns from …*). Selecting a row
  (`?board=`) shows the board's name, style, filter (`sources` choice +
  optional field/option narrowing) and `BoardColumnsEditor` — the existing
  `ColumnRow` UI moved here, each row gaining the **Shows external states…**
  multi-select when a source exists.
- `FieldsSettingsSection.tsx` — definitions as rows (name, type, *Show on
  card* toggle, options editor for select types, delete with the
  `FIELD_IN_USE_BY_SOURCE` refusal in words); **Add field** row.
- `SourcesSettingsSection.tsx` — connected sources as rows (provider glyph,
  name, health pill + remedy button, freshness, write-mode pill); **Connect a
  source** opens `ConnectSourceDialog`: provider picker (registered providers
  only) → OAuth in a popup on `split` / full-page redirect on `single` (the
  comms flow) → container picker from `listContainers` → attach. Selecting a
  row (`?source=`) renders `SourceMappingPanel.tsx`: **States**, **Fields**,
  **People** tables (§5.8), **Write mode** as a `TabBar` radiogroup with the
  copy *"Read only: Jira decides. Read & write: moving a card here moves it in
  Jira, under <owner>'s account."*, **Sync now**, **Pause / Resume**,
  **Remove** (`ConfirmDialog`: *"Its tickets stay on the board as ordinary
  tasks and stop updating."*).

Non-administrators see the sections read-only with the existing sentence
("Only project administrators can change …").

### 6.4 Cards and the dialog

- **External item on a card**: where the project pill sits today, an
  `ExternalKeyPill` — provider glyph (Font Awesome brand set through the shared
  icon primitive) + `PROJ-123`; click opens `externalUrl` in a new tab with
  `noopener`, `stopPropagation` so the dialog does not also open. An unmapped
  assignee renders as a muted `J. Doe · Jira` pill in place of the assignee
  pill. Field chips per §4.5.
- **`TaskDialog`**: a `Notice` at the top of an external task — *Linked to
  Jira PROJ-123 · synced 2 min ago · Open in Jira*; in `read_only` the
  source-owned controls are disabled with a `FieldLabel` hint *Owned by Jira*
  (the scoped-settings rule: greyed and named, never hidden). `TaskFieldsSection`
  per §4.5.

### 6.5 Empty states and copy

| Where | Copy | Action |
|---|---|---|
| Board with no columns | *This board has no columns yet.* | **Add columns** → settings |
| Board whose filter matches nothing (native) | *Nothing on this board. New tasks appear in the first column.* | **New task** |
| Source board, first sync running | *Bringing in Jira PROJ — first sync running.* | — (pill shows progress) |
| Source board, synced, nothing matches | *Connected to Jira PROJ. No issues match this board's columns yet.* | **Board settings** |
| Sources section, none | *Connect Jira, Linear, Trello or GitHub to bring their work onto this project's boards.* | **Connect a source** |
| Sources section, no provider registered on this deployment | *No project tools are configured on this deployment. An operator sets `NESSIE_BOARD_*` to enable one.* | — |
| Fields section, none | *No custom fields. Add one to track anything a task needs beyond title, priority and deadline.* | **Add field** |

Never used: "integration", "sync engine", "data source" as user-facing nouns —
the product says **source**, **board**, **field**, **connection**.

### 6.6 The App Store and the plugin manifest

Each provider gets a first-party manifest in
`api/src/services/integration-plugin-manifests/board-sources.ts` with two
install entries: the existing `remote_mcp_oauth` (Linear, Atlassian, GitHub —
"for agents in conversation") and `native_data_source` — *"Connect from a
project's Settings → Sources; work appears on the project's boards"*. Trello,
which has no MCP row, gets a first-party `McpCatalogEntry` with
`distribution: builtin` and no transport, so `/apps` lists it as one app like
the rest (app-store.md: one row is one app, never a second catalogue).
`IntegratedProduct` rows are seeded with `category: project_management`,
`defaultInstallState: native`, linked by `mcpCatalogEntryId`.

`AppDetailPage` gains one action, **Use as a project board source**, when the
detail response carries `setupSurface: { kind: 'project_sources', provider }`
— decided **server-side** in `app-store-detail.ts` from the manifest's install
modes and the registry (the store reads a decision). It opens a project picker
(`Popover`, the caller's administrable projects) and navigates to
`/projects/:id/settings?section=sources&connect=<provider>`, an intent the
section consumes once (`useConsumedIntent`, as `?connect=true` on the app page
does). The same `setupSurface` shape is the "configure in settings" affordance
the scoped-settings plan recorded as not done for Browserbase; it lands here
with one consumer and Browserbase can adopt it.

A new `ProductSurface` type is deliberately **not** added: the Sources picker
reads the env-driven registry, and the app page reads the manifest it already
has. A surface type would have been a third statement of the same fact.

### 6.7 Phone

- The switcher scrolls its own track inside the header (`TabBar` never calls
  `scrollIntoView`); `KanbanBoard`'s existing column paging handles narrow
  viewports; the `SourceStatusStrip` wraps.
- Settings sections stack; the mapping tables become one row per state with
  the picker below the name (`RowList` already does this).
- Source connect on `single` is a full-page redirect through the same
  server-authored OAuth state; the callback page is the constant HTML page
  that posts to its opener on `split` and navigates back to
  `?section=sources` on `single` — the app-store callback rule, never a
  caller-supplied return URL.
- New navigation case `admin/e2e/navigation/cases/phone-board-switch.mjs`,
  modelled on `phone-tab-switch.mjs`: switching `?board=` animates no
  navigation layer and moves neither region; registered in `cases/index.mjs`.
  `phone-push`, `phone-back` and `phone-cold-start` are unaffected because
  the project's route pattern does not change.

### 6.8 Navigation registrations

- `surfaces.ts` and `prewarm.ts`: the project pattern is unchanged; prewarm
  fetches `GET /api/projects/:id/boards` instead of `/board`.
- `useTabParam` rows: `board` on the board tab, `section` and `source` on
  settings (`source` is a selection inside a section, the `agentTab` precedent
  for a named param).
- Every dialog here is `Dialog`/`ConfirmDialog` on `useOverlay`; the project
  picker is `Popover`; nothing new is added to the allowlists.

## 7. API and contracts (E)

### 7.1 Routes

Gate legend: **member** = `requireActorContext` + `isProjectAccessibleToActor`;
**admin** = member + `canAdministerProject` (org owner, or `ProjectMember.role
∈ {owner, admin}`); **self** = the caller is the connection's owner.

Boards and columns — `api/src/routes/boards.ts` (replaces `board.ts`):

| Route | Gate | Body / result |
|---|---|---|
| `GET /api/projects/:projectId/boards` | member | `BoardRecord[]`, each with its `columns` — the one read the board tab, settings, Overview and prewarm share |
| `POST /api/projects/:projectId/boards` | admin | `{ name, style?, copyColumnsFromBoardId? }` → `BoardRecord` (201) |
| `PATCH /api/projects/:projectId/boards/:boardId` | admin | `{ name?, style?, filter?, position?, isDefault? }` |
| `DELETE /api/projects/:projectId/boards/:boardId` | admin | `?newDefaultBoardId=` required when deleting the default; refuses the last board (`BOARD_LAST`) |
| `GET /api/projects/:projectId/boards/:boardId/tasks` | member | `{ tasks: BoardTaskRecord[], truncated: boolean }` — placed by the server, ≤500 by `updatedAt desc` |
| `POST …/boards/:boardId/columns` | admin | `{ name, category, position?, stateBindings? }` |
| `PATCH …/boards/:boardId/columns/:columnId` | admin | `{ name?, category?, position?, stateBindings? }` |
| `DELETE …/boards/:boardId/columns/:columnId` | admin | placements cascade; cards fall back to category |

`GET /api/projects/:projectId/board` and `/columns*` are removed in the same
change; every admin caller moves.

Tasks — `api/src/routes/tasks.ts`, unchanged shapes except:

| Route | Change |
|---|---|
| `POST /api/tasks/:taskId/move` | `{ columnId, position? }` unchanged; the column implies the board; new refusals `SOURCE_READ_ONLY` (409), `SOURCE_REJECTED` (409, `{ code, detail }`), `BOARD_PROJECT_MISMATCH` (404 as `COLUMN_NOT_FOUND`) |
| `PATCH /api/tasks/:taskId` | gains `fieldValues?: Record<string, unknown \| null>`; refusals `FIELD_UNKNOWN`, `FIELD_VALUE_INVALID` (400), `SOURCE_READ_ONLY`, `SOURCE_REJECTED` |
| `POST /api/tasks/:taskId/assign` | refusals `SOURCE_READ_ONLY`, `SOURCE_REJECTED`, `ASSIGNEE_NOT_LINKED` |
| `GET /api/tasks`, `GET /api/tasks/:taskId` | `TaskRecord` loses `columnId`/`position`, gains `fieldValues` and `externalLink: { sourceId, provider, externalKey, externalUrl, remoteStateName, remoteAssigneeDisplay, lastInboundAt } \| null` |

Fields — `api/src/routes/task-fields.ts`:

| Route | Gate |
|---|---|
| `GET /api/projects/:projectId/fields` | member |
| `POST /api/projects/:projectId/fields` | admin — `{ name, type, options?, config?, showOnCard? }` |
| `PATCH /api/projects/:projectId/fields/:fieldId` | admin — `{ name?, options?, config?, showOnCard?, position? }` (never `type`) |
| `DELETE /api/projects/:projectId/fields/:fieldId` | admin — `FIELD_IN_USE_BY_SOURCE` |

Connections and sources — `api/src/routes/board-sources/connections.ts`,
`sources.ts`, `webhooks.ts`:

| Route | Gate | Notes |
|---|---|---|
| `GET /api/board-sources/providers` | any active member | registered providers, with `containerKinds` |
| `POST /api/board-sources/connections/:provider/start` | any active member | `{ reauthorizeConnectionId? }` → `{ authorizeUrl }`; mirrors `POST /api/comms/connections/:provider/start` |
| `GET /api/board-sources/connections/:provider/callback` | public | constant HTML page; posts `{ ok, connectionId }` to the opener at a server-resolved origin, or navigates to the stored return section on `single` |
| `POST /api/board-sources/connections/trello/complete` | any active member | `{ token }` submitted once, encrypted, never echoed |
| `GET /api/board-sources/connections` | any active member | the caller's own; org owners additionally see `{ id, provider, owner, status }` of every connection (no scopes, no tokens) so they can see whose credential a source runs under |
| `GET /api/board-sources/connections/:id/containers` | self | `listContainers` |
| `POST /api/board-sources/connections/:id/reauthorize` | self | starts OAuth bound to the connection; on completion every source on it returns to `active` with `nextRunAt = now()` |
| `DELETE /api/board-sources/connections/:id` | self | `CONNECTION_IN_USE` while sources name it; otherwise revokes upstream where the provider supports it and deletes the credential row |
| `GET /api/projects/:projectId/sources` | member | health, freshness, write mode, connection owner's display identity |
| `POST /api/projects/:projectId/sources` | admin + self on `connectionId` | `{ connectionId, container }` → seeds mappings, enqueues `board-source.sync.initial` |
| `GET …/sources/:sourceId` | member | with `stateMapping`, `fieldMappings`, the container's `states`/`fields`/`members` as last described, and identity links |
| `PATCH …/sources/:sourceId` | admin (+ self when changing `connectionId`) | `{ name?, writeMode?, syncWindowDays?, connectionId? }` |
| `PUT …/sources/:sourceId/mappings` | admin | `{ stateMapping, fieldMappings, identityLinks }` — whole document, validated against the last description |
| `POST …/sources/:sourceId/sync` | admin | manual; 1 per source per minute |
| `POST …/sources/:sourceId/pause`, `…/resume`, `…/retry` | admin | explicit health transitions |
| `DELETE …/sources/:sourceId` | admin | removes links and the webhook; tasks stay as native tasks |
| `POST /api/board-sources/webhooks/:provider/:token?` (+ `HEAD`) | public | enqueue only |

### 7.2 Contracts and where they live

- `packages/schemas/src/boards.ts` — `BoardIdSchema`, `BoardRecordSchema`,
  `BoardColumnRecordSchema` (with `stateBindings`), `BoardFilterSchema`,
  `BoardTaskRecordSchema`, the create/update bodies.
- `packages/schemas/src/board-lifecycle.ts` — `ColumnCategorySchema`,
  `statusToCategory`, `categoryToStatus`, `ARCHIVED_STATUSES`.
- `packages/schemas/src/task-fields.ts` — `TaskFieldTypeSchema`,
  `TaskFieldDefinitionRecordSchema`, `TaskFieldOptionSchema`,
  `TaskFieldValuesPatchSchema`.
- `packages/schemas/src/board-sources.ts` — provider/health/write-mode enums,
  the five topics and payloads, `BoardSourceRecordSchema`,
  `BoardSourceConnectionRecordSchema`, `StateMappingSchema`,
  `FieldMappingSchema`, `IdentityLinkSchema`, `TaskExternalLinkRecordSchema`.
- `api/src/contracts/tasks-board.ts` re-exports and loses the board shapes it
  owned; `TaskRecordSchema` gains `fieldValues` and `externalLink`. The admin
  derives its types from these (`architecture.md`: no hand-written DTOs).

### 7.3 Authorization

`canAdministerProject(prisma, viewer, projectId)` joins
`isProjectAccessibleToUser` in `packages/team-admin/src/project-structure.ts`;
`server-context.ts` exposes `requireProjectAdmin(actorContext, projectId,
reply)` beside `requireOwner`. Reads stay on the existing entitlement. Task
mutations keep `requireUserActor` + project access; the new refusals are
service errors mapped in the route, never decided in the route.

`ProjectMember` is Nessie-owned (a project has no UOA counterpart), so gating
on its role creates no second identity authority. The iteration routes keep
`requireOwner` untouched — out of scope, and a separate decision.

### 7.4 Realtime

One content-free event, `board.updated { projectId }`, on the `organization`
scope, published by the sync worker once per job and by the API after a
write-back echo. The admin's board facade invalidates
`taskKeys.forProject(projectId)` and `projectKeys.boards(projectId)` on
receipt; the refetch is entitlement-checked, so a project id reaching a
non-member reveals nothing they can read. This is the `dashboard.updated`
shape. `task.updated` is untouched.

### 7.5 PA tools — each mirrors one route

All `personalAssistantOnly`, `category: 'projects'`, calling the same
`@nessie/team-admin` function the route calls:

| tool | route mirrored | change |
|---|---|---|
| `ticket_board_read` | `GET …/boards` | now lists **every board** with its columns (`boardId`, `columnId`, category, style, whether a column binds external states) |
| `ticket_list` | `GET …/boards/:id/tasks` when `boardId` is given, else `GET /api/tasks?project=` | optional `boardId`; output shows `columnId` only for a board read |
| `ticket_read` | `GET /api/tasks/:id` | adds the external link line and field values |
| `ticket_fields_read` (new, `safe`) | `GET …/fields` | definitions with option ids, so `ticket_update` can set them without guessing |
| `ticket_update` | `PATCH /api/tasks/:id` | gains `fieldValues` |
| `ticket_move`, `ticket_assign`, `ticket_transition` | unchanged routes | same `writeBack` collaborator, refusals in words: *"Jira owns this ticket's status; the source is read-only."* / *"Jira refused: PROJ-123 has no transition to Done from In Review."* |

Board, field and source administration deliberately has **no PA tools** in v1:
they are set up once by an administrator on a settings page, and the PA's job
is the work on the board. `project_create` (Agent Designer) creates the
default board through the shared `defaultBoardCreateData`, so a project made
from chat has the same board as a clicked one.

## 8. Files

New:

```
api/prisma/migrations/20260906100000_project_boards/migration.sql
api/prisma/migrations/20260906110000_task_field_definitions/migration.sql
api/prisma/migrations/20260906120000_board_sources/migration.sql
packages/schemas/src/boards.ts · board-lifecycle.ts · task-fields.ts · board-sources.ts
packages/team-admin/src/board-structure.ts · board-placement.ts · task-fields.ts
packages/team-admin/src/board-source-apply.ts · board-source-credential.ts · board-source-writeback.ts · project-administration.ts
packages/board-sources/ · board-source-jira/ · board-source-linear/ · board-source-trello/ · board-source-github/ · board-source-providers/
api/src/routes/boards.ts · task-fields.ts · board-sources/{connections,sources,webhooks}.ts
api/src/services/boards.ts · task-fields.ts · board-sources.ts (re-exports, per the PA-tools rule)
api/src/services/integration-plugin-manifests/board-sources.ts
worker/src/control/board-source-sync.ts · board-source-webhook.ts · board-source-health-dispatch.ts · board-source-webhooks-renew.ts
worker/src/run/pa-tools/ticket-fields.ts
admin/src/facades/boards/hooks.ts (replaces facades/board) · facades/task-fields/hooks.ts · facades/board-sources/hooks.ts
admin/src/components/kanban/BoardSwitcher.tsx · SourceStatusStrip.tsx · ExternalKeyPill.tsx · TaskFieldsSection.tsx · TaskFieldControl.tsx
admin/src/pages/project/settings/BoardsSettingsSection.tsx · BoardColumnsEditor.tsx · BoardCreateDialog.tsx · FieldsSettingsSection.tsx · SourcesSettingsSection.tsx · ConnectSourceDialog.tsx · SourceMappingPanel.tsx
admin/src/pages/settings/connections/ProjectToolConnections.tsx
admin/e2e/navigation/cases/phone-board-switch.mjs
```

Changed: `api/prisma/schema.prisma`; `packages/team-admin/src/project-structure.ts`,
`project-tasks.ts`, `project-task-move.ts`, `project-task-records.ts`;
`packages/runtime/src/builtin-ticket-tools.ts`; `worker/src/run/pa-tools/tickets.ts`;
`worker/src/control/index` wiring and the periodic intervals; `api/src/register-api-routes.ts`;
`api/src/lib/server-context.ts`; `api/src/contracts/tasks-board.ts`;
`packages/schemas/src/realtime-ws.ts` (`board.updated`), `ids.ts` (`BoardIdSchema`);
`packages/mcp-manage/src/apps/app-store-detail.ts` (`setupSurface`);
`admin/src/pages/project/ProjectView.tsx`, `ProjectBoardTab.tsx`,
`ProjectSettingsPage.tsx` (becomes the host); `admin/src/components/kanban/KanbanBoard.tsx`,
`KanbanCard.tsx`, `TaskDialog.tsx`, `kanban-config.ts`;
`admin/src/components/features/projects/ProjectWorkSection.tsx`,
`project-dashboard-data.ts`; `admin/src/navigation/prewarm.ts`;
`admin/src/pages/AppDetailPage.tsx`; `admin/src/lib/query-keys.ts`;
`admin/test/tab-param.test.ts`; `docs/navigation/page-types-and-motion.md` §1;
`docs/standards/comms-connector.md` gains a sibling sentence pointing here, and
`AGENTS.md` → Architecture gains one routing bullet for this document.

Deleted: `api/src/routes/board.ts`, `api/src/services/board.ts`,
`admin/src/facades/board/hooks.ts`.

## 9. Delivery plan (F)

Each phase is one PR, mergeable and useful alone, in dependency order.
**Phase 1 is the smallest thing that is genuinely shippable**: after it a
project has many boards with their own columns, and nothing else in the product
changes.

| # | Phase | Contents | Acceptance |
|---|---|---|---|
| 1 | **Boards as views** | Migration 1; `Board`/`BoardColumn`/`TaskBoardPlacement`; `board-structure.ts`, `board-placement.ts`; moved lifecycle maps; `boards.ts` routes; `canAdministerProject`; PA `ticket_board_read`/`ticket_list` changes; `BoardSwitcher`, `ProjectBoardTab` on the board read, `BoardsSettingsSection` + `BoardColumnsEditor`, Overview links per board; `phone-board-switch`; tab-param table + test | Throwaway-DB migration apply; a project shows its migrated board with existing pins intact; create a second board with different columns, drag the same task on both, both remember; an agent run completing the task moves it to Done on both boards (T3 fixed — pinned test); a project admin who is not org owner can add a column; `ticket_move` still works with a `columnId` from `ticket_board_read`; Playwright screenshots at desktop and phone |
| 2 | **Custom fields** | Migration 2; `TaskFieldDefinition`, `Task.fieldValues` + GIN; `task-fields.ts` (both packages); routes; `TaskFieldsSection`, card chips, `FieldsSettingsSection`; board `field` filter; `ticket_fields_read`, `ticket_update.fieldValues` | Define seven fields of the seven types, set values in the dialog, see chips on the card; a board filtered on a select option shows only matching cards (DB-backed test on the GIN path); deleting a definition clears values (test proves the `- key` runs); type change refused |
| 3 | **Sources core + Linear, read-only** | Migration 3; `@nessie/board-sources` + `board-source-linear` + `board-source-providers`; connection OAuth routes + Connections page group; source routes; sync worker (initial, incremental, sweep, webhook, renew); `applyInboundItem`; health transitions + `board_source_health` alert; `SourcesSettingsSection`, `ConnectSourceDialog`, `SourceMappingPanel`, `SourceStatusStrip`, `ExternalKeyPill`, dialog banner; `board.updated`; App Store manifests + `setupSurface` | Connect Linear, attach a team, see issues on the board within the sync window with correct categories; a state renamed in Linear reflects within the poll interval; a webhook delivery updates a card without a poll; revoking the token in Linear moves the source to `needs_reauthorization` with exactly one alert (DB test on `healthRevision`); a deactivated owner produces `owner_inactive`; the source's tasks are readable by `ticket_read` with the link line; removing the source leaves native tasks |
| 4 | **Write-back (Linear)** | `writeMode`, `board-source-writeback.ts`, the `writeBack` collaborator in move/update/assign, refusals, echo suppression, `stateBindings` on columns, identity links + email matching + People table | In `read_only` a category-changing drag snaps back with the sentence; in `read_write` it changes the Linear state and the webhook echo writes no `TaskEvent` (fingerprint test); an invalid target is refused synchronously; assigning an unlinked user is refused with the remedy; a bound column writes back its bound state |
| 5 | **Jira adapter** | 3LO, `cloudId`, `search/jql` paging, `statusCategory` defaults, transitions resolution, unsigned webhooks with URL token + 30-day renew sweep, `/user/search` email match | Same checks as 3 and 4 against a Jira Cloud site; `JIRA_NO_TRANSITION` surfaces on a workflow that forbids the move; webhook renewal proven by a clock-advanced test |
| 6 | **GitHub adapter** | App JWT + installation tokens, user-to-server link, Issues container, Projects v2 container (GraphQL), `X-Hub-Signature-256`, `projects_v2_item` | An Issues repo and a Projects v2 board each attach and sync; closing an issue in GitHub moves the card to Done; moving a Projects item changes its `Status` |
| 7 | **Trello adapter** | Key + one-shot token flow, lists as states, HEAD-then-POST webhooks with HMAC-SHA1, poll re-read | Attach a board; list moves reflect; a card moved in Nessie moves in Trello |

Phases 5–7 are independent of each other and can be built in parallel once 4
has landed.

## 10. Deliberately not in v1

- **Swimlanes / group-by** on a board. The filter vocabulary is closed; a
  second axis is a later, separate decision.
- **Per-board field visibility** (`showOnCard` is per definition, not per
  board).
- **Comments, attachments and history import.** Comments have their own
  audience upstream (§5.3); attachments need the `FileService` chokepoint and
  quota, a second design.
- **Sprint ↔ iteration sync** (Jira sprints, Linear cycles, Projects
  iteration fields) and Jira Software boards as containers.
- **Creating upstream from Nessie.** A native task on a source board stays
  native; "New task" does not create a Jira issue. The inbound direction is
  what "use them as a data source" asks for.
- **Run-lifecycle write-back.** `updateTaskStatus` on a mirrored task changes
  Nessie's status only. The hook is one `enqueueQueueJob` in
  `applyTaskStatus` behind a source flag; it is not built until a person asks
  for an agent's completion to close a Jira ticket unattended.
- **Ticket tools for shared agents**, and therefore the `requiresApproval`
  gate on external writes they would need.
- **Organisation-level field definitions**, **field types beyond seven**,
  **a query builder**.
- **MCP-backed sources.** Stated in §5.2; the MCP connectors keep their job.
- **A new `ProductSurface` type** (§6.6).
- **Multiple links per task** (one task ↔ one external item).

## 11. Risks and open questions (G)

Each with the default the build proceeds on.

1. **Provider app registration is a deployment prerequisite.** Every adapter
   needs a per-deployment client id/secret (and, for GitHub, an App with a
   private key and webhook secret; for Trello, a Power-Up key and secret).
   *Default:* `NESSIE_BOARD_<PROVIDER>_*` env, unset means unregistered and
   hidden, documented in `docs/deployment.md` in phase 3. Production needs the
   Linear app created before phase 3 ships.
2. **Linear webhook delivery for OAuth apps.** The adapter assumes app-level
   webhooks fire for every authorised workspace, signed with the app's webhook
   secret. *Default:* build the webhook path against that, and rely on the
   adapter-declared 5-minute poll as the fallback, so a wrong assumption costs
   freshness, not correctness. Verify in phase 3 before the PR.
3. **Jira webhooks are unsigned and expire.** *Default:* per-source URL token
   (hashed) plus the renew sweep; if a deployment cannot expose a public
   callback, the poll carries it. Confirm the allowed-callback-domain
   requirement on the Atlassian developer console during phase 5.
4. **Project administrators gate boards.** This widens who can change a
   board from org owners to `ProjectMember.role ∈ {owner, admin}` — the row
   exists and is written, but nothing has enforced it before, so some projects
   may have stale `admin` rows. *Default:* proceed; it is Nessie-owned data and
   an org owner can correct membership.
5. **Email auto-matching of assignees.** Matching a provider's email to
   `User.email` is a read of UOA-mirrored data, but a wrong match assigns work
   to the wrong person. *Default:* exact, case-folded equality against
   **active** members only, recorded as `matchedBy: 'email'` and visible in the
   People table where it can be overridden; never fuzzy.
6. **Dropping `Task.columnId` / `position`.** `TaskRecord` is consumed by the
   admin only (`mobile/` and `ios/` have no reader), but a stale client would
   send `columnId` it no longer receives. *Default:* drop in phase 1; the
   contract is versioned by deploy, and the admin ships in the same PR.
7. **Board size.** `GET /api/tasks` caps at 200 silently; a Jira project can
   have thousands of open issues. *Default:* the board read returns ≤500 by
   `updatedAt desc` with a visible *"Showing the 500 most recently updated"*
   notice, and the initial import bounds done work by `syncWindowDays`. A
   paginated board is not designed here.
8. **Realtime scope for `board.updated`.** No `project` WS scope exists.
   *Default:* organisation scope, content-free (a project id only), refetch
   entitlement-checked — the `dashboard.updated` reasoning.
9. **Push preference for source health.** *Default:* a new
   `pushBoardSourceHealth` key beside `pushTriggerHealth`, generic body,
   cause behind the deep link — not a shared "any capability health"
   preference, which would need its own design.
10. **Rate limits under many sources.** *Default:* one `rate_limited`
    transient with the shared backoff and a per-organisation concurrency cap
    of 2 sync jobs (`NESSIE_BOARD_SOURCE_CONCURRENCY`), following the
    dashboard refresh caps; no per-provider budget accounting in v1.
11. **GitHub App permission scope.** An installation may be scoped to
    selected repositories, so a container the person can see may be outside
    the installation. *Default:* `listContainers` lists only what the
    installation token can reach and says so in the picker's empty state.
12. **BuildMe.** T10's placeholders point at this design. *Default:* leave the
    BuildMe manifest's `column-mapping` control `blocked` until its board API
    exists; when it does, it is a fifth adapter and nothing here changes.

## 12. As built

Every phase in §9 shipped. This section records where the code differs from the
design above, so the design stays readable as intent and this stays true as
fact. Read this before treating any section above as a description of the code.

### Deltas

- **§3.7 the board filter** is stored, contract-checked and applied
  (`boardFilterWhere`), but **has no editor**. A board's filter can only be set
  through the API today. Deliberate: a control that narrows a board is only
  legible once a project has more than one source or a select field to narrow
  by, and shipping an empty picker would have been a control that names no
  decision.
- **§5.7 write-back for `updateProjectTask`** covers title, detail and deadline.
  Priority and custom fields are **not** written upstream — they are mapped
  *inbound* only. A person editing a mapped custom field on a mirrored task
  changes Nessie's copy, and the next sync overwrites it. This is the one place
  where local and remote can disagree, and it is the first thing to close.
- **§5.10 `misconfigured` for `FIELD_GONE`** is not detected: a mapped external
  field that disappears upstream simply stops being written. `UNMAPPED_STATE`,
  `CONTAINER_GONE`, `WEBHOOK_REGISTRATION_FAILED` and
  `PROVIDER_NOT_CONFIGURED` all are.
- **§6.1 two doorways** are not built: the column header's *Edit columns* menu
  (the settings page is reachable from the header's Configure menu instead), and
  the Overview Work section's per-source health line (the board's own
  `SourceStatusStrip` carries it).
- **§7.5 `ticket_list`** did not gain its optional `boardId`. It still lists a
  project's tasks; `ticket_board_read` lists every board with its columns, which
  is what `ticket_move` needs.
- **§9 phase 6, GitHub Projects v2** is read-only. `applyChange` refuses a
  write-back to a Projects board by name
  (`GITHUB_PROJECT_READ_ONLY`) rather than pretending to have made one;
  repository issues write back fully.
- **§5.6 `board-source.sync.sweep`** is not a queue topic. The worker's own
  30-second interval claims due sources directly, exactly as the dashboard
  refresher does, so there is no second scheduler.

### Not yet verified against a live vendor

Every adapter is unit-tested on its normalisation, its state mapping and its
signature verification, and the whole inbound and write-back path is tested
against a real database with a stand-in adapter. **None of the four has been
run against the real provider**, because that needs an app registered with each
vendor — see
[configuration](../deployment/configuration.md) → "Project board sources".
The specific assumptions to check on first connect:

- **Linear** — that app-level webhooks fire for every authorised workspace, and
  that `Linear-Signature` is an HMAC-SHA256 of the raw body. A wrong assumption
  here costs freshness only: the adapter declares a five-minute poll.
- **Jira** — that `/rest/api/3/search/jql` paginates by `nextPageToken` as
  documented, and that the developer console permits this deployment's callback
  domain for webhook registration.
- **GitHub** — that a classic OAuth token reaches `projectsV2` on the viewer
  (a GitHub App installation token does not).
- **Trello** — that the token arrives in the fragment as `token=` and that
  `x-trello-webhook` is base64(HMAC-SHA1(body + callbackURL)).
