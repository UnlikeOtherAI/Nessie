# Board-scoped labels and attachment removal

Part of [ticket comments, attachments and labels](overview.md). An addendum
written after the feature was built (PR #603) and Ondrej answered §2. It
changes two decisions and specifies the change against the code **as built**,
not against the earlier chapters; where this chapter and an earlier chapter
disagree, this chapter wins. Section numbers continue the folder's numbering.

Ondrej, verbatim: *"Label scope should belong to a board, not a project. Don't
worry about files going back to Linear. Anyone can remove an attachment, but
it'll stay marked as removed. It can still be downloaded. It'll show who
uploaded it and who disabled it, and they should be able to put a comment on
why they're doing so."*

## 8. Labels belong to a board

### 8.1 What "a board" means for a task, stated once

The as-built model already answers most of the hard questions, because a board
**owns** its tasks (`board-placement.ts`, `boardTaskPoolWhere`):

- **A task is on exactly one board.** `Task.boardId` names it; `null` means
  *the project's default board* — what every board-unaware writer (agent runs,
  triggers, mailbox, source sync) produces. `TaskBoardPlacement` is a column
  pin keyed `(taskId, boardId)` and is only ever read for the owning board; it
  is not membership. "A task placed on several boards" does not exist and this
  chapter does not invent it.
- **The task's home board** is therefore `Task.boardId ?? defaultBoardOf(projectId)`.
  One helper answers it everywhere: `resolveTaskHomeBoard` (§8.4). A task with
  no project has no home board and carries no labels — the rule the code has
  today as `LABEL_NOT_IN_PROJECT` when `projectId` is null.
- **Changing home board happens in three places only:** a drop or `ticket_move`
  onto another board's column (`project-task-move.ts`, `changesBoard`),
  deleting a board (`ON DELETE SET NULL` → the default board), and promoting a
  new default (`updateBoard`, which first materialises `boardId` on every
  `null` task onto the *old* default, so nothing moves). Each is handled in
  §8.5; the third needs nothing.

**A label belongs to one board.** Its name is unique on that board. A
source-owned label belongs to a board *and* a source. The same Linear label
*Bug* on two boards is two rows with two colours, and that is the intended
consequence of the request, not an accident to paper over.

### 8.2 Schema

`api/prisma/schema.prisma` — `TaskLabel` gains `boardId`, keeps `projectId`
(denormalised, and pinned to the board's project by a composite key the
storage layer enforces, the `TaskBoardPlacement.column` pattern):

```prisma
/// A board's label. `sourceId`/`externalId` are set when a board source owns
/// it (Linear team label, GitHub label, …) — per board, so a mirrored ticket
/// on any board finds its source labels on its own board. A label a person
/// made in Nessie has both null and is "Nessie-only" on a mirrored ticket.
model TaskLabel {
  id              String   @id @default(uuid()) @db.Uuid
  organizationId  String   @map("organization_id") @db.Uuid
  projectId       String   @map("project_id") @db.Uuid
  boardId         String   @map("board_id") @db.Uuid
  name            String
  normalizedName  String   @map("normalized_name")
  color           String   @default("#6b7280")
  sourceId        String?  @map("source_id") @db.Uuid
  externalId      String?  @map("external_id")
  createdByUserId String?  @map("created_by_user_id") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  organization Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  project      Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)
  // COMPOSITE on (boardId, projectId): a label's project is its board's project
  // by construction, not by the one writer remembering to check.
  board        Board           @relation(fields: [boardId, projectId], references: [id, projectId], onDelete: Cascade)
  source       BoardSource?    @relation(fields: [sourceId], references: [id], onDelete: SetNull)
  links        TaskLabelLink[]

  @@unique([boardId, normalizedName])
  @@unique([boardId, sourceId, externalId])
  @@index([boardId, name])
  @@index([projectId])
  @@map("task_labels")
}
```

`Board` gains `labels TaskLabel[]`. `Board` already has
`@@unique([id, projectId, organizationId])`; add `@@unique([id, projectId])`
for this FK (Prisma needs the exact referenced tuple).

`ON DELETE CASCADE` on the board is a backstop only: `deleteBoard` re-homes
the board's labels onto the default board *before* the row goes (§8.5), so
the cascade finds nothing.

### 8.3 Migration — a new `20260921140000_board_labels_attachment_removal`

PR #603 merged and deployed `20260921120000` before this chapter was built,
so that migration is immutable (`scripts/lint-migrations.mjs`) and may have
run in production. This change is a **new forward migration**; production is
greenfield, but the migration still converts what it finds rather than
dropping it.

In order:

1. `CREATE UNIQUE INDEX "boards_id_project_id_key" ON "boards"("id", "project_id")`
   (the composite FK target), then `ALTER TABLE "task_labels" ADD COLUMN "board_id" UUID`.
2. **Re-home every existing project-scoped label onto every board that needs
   it.** A task's home board in SQL is `coalesce(t.board_id, d.id)` where `d`
   is the project's `is_default` board. For each label, the target boards are
   the distinct home boards of the tasks linked to it, plus the project's
   default board (so an unused label survives somewhere). The first target
   keeps the existing row (`UPDATE … SET board_id`); every further board gets
   a copy (`INSERT … SELECT` with a new uuid, same name, colour, source and
   external id), and each `task_label_links` row is repointed to the copy on
   its task's own home board. A project with no boards at all has its labels
   deleted (nothing can show them).
3. `ALTER COLUMN "board_id" SET NOT NULL`; drop the old unique indexes
   `(project_id, normalized_name)` and `(source_id, external_id)` and the
   `(project_id, name)` index; create `(board_id, normalized_name)` unique,
   `(board_id, source_id, external_id)` unique, `(board_id, name)` and
   `(project_id)` indexes; add
   `FOREIGN KEY ("board_id", "project_id") REFERENCES "boards"("id", "project_id") ON DELETE CASCADE`.
4. The attachment columns of §9.2 (`ALTER TABLE "attachments" ADD COLUMN …`).
5. Must be a no-op-safe apply on an empty database and on the upgrade
   baseline.

### 8.4 Shared functions — `packages/team-admin`

New, in `board-placement.ts` (beside `resolveProjectTaskDetailPlacement`, the
one file that already knows what `boardId: null` means):

```ts
/** The board a task's labels live on: its own, or the project's default. Null for a projectless task. */
export const resolveTaskHomeBoard = async (
  db: PrismaClient | Prisma.TransactionClient,
  task: { projectId: string | null; boardId: string | null },
): Promise<{ id: string; projectId: string; organizationId: string } | null>
```

`task-labels.ts`, renamed and re-keyed (the old names are deleted, not
aliased — nothing outside this PR imports them):

```ts
export type BoardRef = { id: string; projectId: string; organizationId: string }

export const listBoardLabels   = (prisma, boardId: string) => Promise<TaskLabelRecord[]>      // name order, taskCount
export const listProjectLabels = (prisma, projectId: string) => Promise<TaskLabelRecord[]>    // every board's, board then name
export const createBoardLabel  = (prisma, board: BoardRef, input: { name; color?; createdByUserId }) => Promise<TaskLabelRecord | TaskLabelError>
export const updateBoardLabel  = (prisma, board: BoardRef, labelId, patch: { name?; color? })  => Promise<TaskLabelRecord | TaskLabelError>
export const deleteBoardLabel  = (prisma, board: BoardRef, labelId)                            => Promise<{ ok: true } | { error: 'LABEL_NOT_FOUND' }>
```

`findByName` keys on `boardId_normalizedName`. `LABEL_NAME_TAKEN` means
"taken on this board". `listProjectLabels` stays because the backlog, the
search page and the PA's `ticket_labels_read` are project-wide surfaces.

`planTaskLabels` takes the task's board instead of its project:

```ts
export type TaskLabelSetError = {
  error: 'LABEL_NOT_ON_BOARD' | 'LABEL_NOT_IN_TASK_SOURCE'
  labelId?: string
}
export const planTaskLabels = async (
  prisma,
  task: { id: string; projectId: string | null; boardId: string | null; sourceId: string | null },
  labelIds: readonly string[],
): Promise<TaskLabelPlan | TaskLabelSetError>
```

It resolves the home board first; every requested id must be a label of
that board (`LABEL_NOT_ON_BOARD`, the renamed `LABEL_NOT_IN_PROJECT`), and
the foreign-source check keeps its meaning under the renamed
`LABEL_NOT_IN_TASK_SOURCE`. `findAccessibleTask` selects `boardId` so
`setTaskLabels` and `updateProjectTask` can pass it without a second read.
`createProjectTask` resolves `input.boardId ?? default` once, validates
`labelIds` against it, and writes the same `applyTaskLabelPlan` it does today.

`board-source-apply.ts` — a source's labels are per board:

```ts
export type SourceLabelOwner = { id: string; organizationId: string; projectId: string }
export const upsertSourceLabels = (db, source: SourceLabelOwner, board: BoardRef, labels) => Promise<Map<string, string>>
export const syncTaskSourceLabels = (db, source, task: { id: string; boardId: string | null }, labels, options) => Promise<{ added; removed }>
```

`syncTaskSourceLabels` resolves the task's home board (a task the sync just
created has `boardId: null` ⇒ default) and upserts onto it; adoption of a
same-name Nessie-only label is per board; "a name another source owns" is
per board. The webhook's `resource: 'label'` re-describe (`board-source-webhook.ts`)
becomes an `updateMany` on `{ sourceId, externalId }`, because one provider
label is now one row per board; the collision rule (keep the old name, take
the colour) runs per row.

### 8.5 Labels follow the ticket by name

A task that changes home board keeps its labels **by name**. Two new
functions in `task-labels.ts`, both inside the caller's transaction:

```ts
/** Find, or create, the label on `board` that stands for `label`: same normalised name; a source-owned label also same (sourceId, externalId). */
export const findOrCreateLabelOnBoard = (tx, board: BoardRef, label: { name; color; sourceId; externalId }) => Promise<{ id: string }>
/** Re-point every link of `taskId` from its old board's labels to `board`'s equivalents; writes one `labels_rehomed` event. */
export const rehomeTaskLabels = (tx, task: { id: string }, board: BoardRef, by: string) => Promise<void>
/** Every label of `from` gets an equivalent on `to` and its links move; the empty rows are deleted. Used by deleteBoard. */
export const rehomeBoardLabels = (tx, from: BoardRef, to: BoardRef) => Promise<void>
```

Rules, decided:

- **Create when missing** — a move never drops information. A Nessie-only
  label becomes a Nessie-only label on the target (name, colour). A
  source-owned label becomes a source-owned label on the target with the same
  `(sourceId, externalId)`, so the next sync's replace-subset still finds it.
  Adoption by name applies (a same-name Nessie-only label on the target is
  adopted by the source, the §8.4 rule).
- `project-task-move.ts` calls `rehomeTaskLabels` when `changesBoard` is
  true, after the task row update, with `by: input.actorId`. The
  `labels_rehomed` `TaskEvent` payload is
  `{ by, fromBoardId, toBoardId, mapping: [{ from: labelId, to: labelId }] }`.
- `board-structure.ts` `deleteBoard` calls `rehomeBoardLabels(tx, dying, default)`
  before `tx.board.delete`; the tasks' `ON DELETE SET NULL` then lands them
  on the same board their labels just moved to. No event per task — the board
  deletion is the audit trail.
- Promoting a default board moves nothing (§8.1) and touches no label.
- A source label that no task on the target board carries yet is created
  lazily by the move or the sync, never eagerly for every board.

### 8.6 Wire shapes — `packages/schemas`

```ts
export const TaskLabelRecordSchema = TaskLabelSummarySchema.extend({
  projectId: ProjectIdSchema,
  boardId: z.string().uuid(),            // new
  source: …, taskCount: …, createdAt: …, updatedAt: …,
})
```

`TaskLabelSummarySchema` (what a `TaskRecord` and a card carry) is
**unchanged**: a pill needs a name and a colour, and a card never asks which
board a label is on — the board it is on is the task's. The backlog and the
search page render the same summaries for tasks from every board; nothing
there changes.

`BoardFilter` gains **no** `labels` arm in this chapter. There is no filter
editor in the admin (`BoardColumnsEditor` says so in its own comment: a
"Review queue" board is built without a filter vocabulary), so a label filter
would be a new surface, not a consequence of scope. It is the natural next
chapter once labels are the board's own; recording it here is enough.

### 8.7 Routes and gates

Reads and writes move to the board path; the project-wide read stays. All
under the existing board gate (`isProjectAccessibleToActor` + the board must
belong to the project, the `boards.ts` `loadProject` pattern) and
`requireProjectModifier` for writes — the same authority as today, one path
deeper. Every change still publishes `board.updated { projectId }`.

| Route | Replaces |
|---|---|
| `GET /api/projects/:projectId/labels` → `{ labels }`, every board's, `boardId` on each | unchanged shape, wider meaning |
| `GET /api/projects/:projectId/boards/:boardId/labels` → `{ labels }` | new |
| `POST /api/projects/:projectId/boards/:boardId/labels` — `CreateTaskLabelBody` → 201 record; 409 `LABEL_NAME_TAKEN` with the board's existing label in `details.label` | `POST /api/projects/:projectId/labels` |
| `PATCH …/boards/:boardId/labels/:labelId` — `UpdateTaskLabelBody` | `PATCH /api/projects/:projectId/labels/:labelId` |
| `DELETE …/boards/:boardId/labels/:labelId` → 204 | `DELETE /api/projects/:projectId/labels/:labelId` |

`BOARD_NOT_FOUND` (404) when the board is not the project's. `labelIds` on
`POST /api/tasks` and `PATCH /api/tasks/:taskId` are unchanged on the wire;
`LABEL_NOT_ON_BOARD` (400, field `labelIds`) replaces `LABEL_NOT_IN_PROJECT`
in `sendTaskActivityError` and the task routes' error maps.

### 8.8 Agent tools

Both surfaces keep their names; inputs gain `boardId` where a board is being
addressed, and it is **optional everywhere a task create is**: absent means
the project's default board, exactly as `ticket_create` and
`nessie_task_create` already read `boardId`.

| Tool | Input change | Behaviour |
|---|---|---|
| `nessie_label_list` | `+ boardId?` | with it, that board's labels; without, every board's, each with `boardId` |
| `nessie_label_create` | `+ boardId?` | creates on that board (default when absent); `LABEL_NAME_TAKEN` returns that board's label |
| `nessie_label_update` / `nessie_label_delete` | `+ boardId?` | the label is looked up by id inside the project; `boardId`, when given, must match or it is `LABEL_NOT_FOUND` |
| `ticket_labels_read` | `+ boardId?` | lines gain `boardId=…`; without a board the list is grouped by board with a `Board "Dev"` heading line |
| `ticket_label_create` | `+ boardId?` | as `nessie_label_create` |
| `labelIds` on create/update (both surfaces) | none | must be the ticket's home board's; refused `LABEL_NOT_ON_BOARD` with the sentence "That label is not on this ticket's board. Read them with ticket_labels_read." |

Tool descriptions say "a board's labels" and that a ticket's labels are the
labels of the board it is on. `builtin-ticket-tools.ts` `LABEL_IDS` says
"label UUIDs of the ticket's board from ticket_labels_read".

### 8.9 Where label management lives — Rule zero

**Board → Settings → Labels**: `/projects/:projectId/boards/:boardId/settings?tab=labels`,
a fourth tab beside General, Columns and Watchers in `BoardSettingsPage`
(`TABS = ['general', 'columns', 'watchers', 'labels']`). `LabelsSettingsSection`
keeps its file and its anatomy (create row, rename inline, recolour, delete
with count) and takes `{ boardId, projectId }`; its description reads
*"Labels belong to this board. A ticket moved to another board keeps its
labels by name."*

Doorways, each verified in the fixture (§10.5):

1. The token dropdown's footer *Manage labels…* links to the ticket's home
   board's Labels tab. `TaskLabelsField` takes `boardId` (§8.10) and builds
   the link from it.
2. The boards directory (`ProjectBoardsPage`) already links each board to its
   settings; the tab is one click in.
3. **Old links keep working:** Project → Settings `?section=labels` renders a
   redirect to the default board's Labels tab, the `LegacyProjectBoardSettingsRedirect`
   pattern (it reads `useProjectBoards` for `isDefault`). `SECTIONS` in
   `ProjectSettingsPage` loses `'labels'` and the tab strip loses the tab.

### 8.10 The dialog and the card

`TaskLabelsField` props: `projectId` stays (query keys, the settings link),
`boardId: string` is added and is the board whose labels the field lists and
creates on. `TaskDialog` resolves it once:

```ts
const boards = useProjectBoards(labelsProjectId ?? undefined)
const labelsBoardId = resolveHomeBoardId(boards.data, task?.boardId ?? boardId ?? null)   // null until boards load
```

`resolveHomeBoardId(boards, boardId)` is a pure helper beside the facade:
the named board when it is in the list, else the board with `isDefault`,
else null. While it is null the field is disabled with the placeholder
*Loading labels…* (the existing loading branch). In create mode from the
backlog (no `boardId` prop) the default board is used — the same board the
create lands on.

Facades: `projectKeys.labels(projectId)` becomes the family root and
`projectKeys.boardLabels(projectId, boardId) = ['projects', projectId, 'labels', boardId]`,
so the realtime `board.updated` handler's prefix invalidation of
`projectKeys.labels(projectId)` already covers every board. Hooks take
`(projectId, boardId)`: `useBoardLabels`, `useCreateBoardLabel`,
`useUpdateBoardLabel`, `useDeleteBoardLabel`; `useProjectLabels(projectId)`
stays for the project-wide read. `query-key-invariants.test.ts` gains the
new key row.

`KanbanCard` is unchanged by labels. The backlog and search render summaries
as today.

## 9. Attachment removal is a mark, not a delete

### 9.1 The rule

**Anyone who can see the ticket may remove a file on it. Removal marks the
row; the bytes stay; the file stays downloadable to whoever can see the
ticket; the row shows who uploaded it, who removed it, when, and why.** There
is no restore in v1: the row keeps everything a restore needs (one
`updateMany` clears four columns), and an undo door doubles the states every
surface must render for an outcome the request did not ask for.

What "anyone who can see" means in code: `findAccessibleTask` alone. The
`ATTACHMENT_NOT_REMOVABLE` predicate (uploader or `canModifyProject`) is
deleted, not loosened. The dialog offers Remove under `canEdit`, as every
other write in the dialog does; today every door that returns a task answers
`viewerCanEdit: true`, and a future read-only door hides Remove together with
the composer and Upload.

Provider-stored copies (`external.status === 'stored'`) and link rows stay
non-removable in v1, as they are today: they are the provider's files, and
"removed in Nessie" would mean nothing upstream. Files that came in with a
comment are ordinary files and are removable like any other.

### 9.2 Schema

`Attachment` gains four nullable columns, bare like `uploaderId` (no
relation; the row outlives the people):

```prisma
  /// Soft removal from a ticket (ticket files only). The bytes stay and the
  /// `taskId` ACL arm keeps serving them; the row is rendered as removed.
  removedAt        DateTime? @map("removed_at")
  /// The person who removed it — the actor's person, or null for an
  /// unattended agent run (then `removedByAgentId` is set alone).
  removedByUserId  String?   @map("removed_by_user_id") @db.Uuid
  /// Set when an agent removed it as itself (a shared agent in a project
  /// channel); a personal assistant acts as its person and leaves it null.
  removedByAgentId String?   @map("removed_by_agent_id") @db.Uuid
  /// Free text the remover gave, at most 500 characters; null when none.
  removedReason    String?   @map("removed_reason") @db.Text
```

Migration: in `20260921140000` (§8.3, step 4), an `ALTER TABLE
"attachments"` statement adds the four columns beside `task_id` and
`task_comment_id`. No index — the list is read by `task_id` and the card
count filters on `removed_at IS NULL` within that index's rows.

### 9.3 Wire shapes

```ts
export const TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS = 500
/** What the comment-delete path writes as the reason, so a client can render it as a system note rather than a quote. */
export const COMMENT_REMOVAL_REASON = 'Removed with the comment.'

export const TaskAttachmentRemovalSchema = z.object({
  at: TimestampSchema,
  byUserId: UserIdSchema.nullable(),
  byAgentId: AgentIdSchema.nullable(),
  reason: z.string().max(TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS).nullable(),
})
// on TaskAttachmentRecordSchema:
  removed: TaskAttachmentRemovalSchema.nullable(),

export const RemoveTaskAttachmentBodySchema = z
  .object({ reason: z.string().trim().max(TASK_ATTACHMENT_REMOVE_REASON_MAX_CHARS).optional() })
  .strict()
```

`reason` is **optional**: Ondrej said they *should be able to* say why.
Empty after trim is stored as null. A link row (external, no stored copy)
always has `removed: null`.

### 9.4 Shared functions

```ts
export const removeTaskAttachment = async (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; attachmentId: string; reason?: string | null },
): Promise<
  | { ok: true; projectId: string | null; attachment: TaskAttachmentRecord }
  | { error: 'NOT_FOUND' | 'ATTACHMENT_NOT_ON_TASK' | 'ATTACHMENT_NOT_REMOVABLE' | 'ATTACHMENT_ALREADY_REMOVED' }
>
```

- `files: TaskFileDeleter` is gone from the signature; the function never
  touches `FileService`. `TaskFileDeleter` is deleted from the package
  (`nessie_task_attachment_add`'s failed-link cleanup calls
  `context.fileService.delete` directly and keeps doing so).
- `ATTACHMENT_NOT_REMOVABLE` now means only "a provider-stored copy" (the row
  has a `TaskExternalAsset` with `status: 'stored'` pointing at it).
- `ATTACHMENT_ALREADY_REMOVED` (409): a second removal does not overwrite the
  first remover or reason.
- The write: `updateMany where { id, taskId, removedAt: null }` setting
  `removedAt: now`, `removedByUserId: actor.unattended ? null : actor.userId`,
  `removedByAgentId: actor.agentId ?? null`, `removedReason`; a count of 0
  after the pre-read is the race and answers `ATTACHMENT_ALREADY_REMOVED`.
  Then the `TaskEvent`
  `attachment_removed { by, attachmentId, reason, commentId? }` — `by` is
  `taskEventBy(actor)` as before.
- `listTaskAttachments` includes removed rows (newest-first ordering
  unchanged; removal does not reorder) and maps `removed`.
  `taskAttachmentSelect` gains the four columns.
- `countTaskAttachments` (`project-task-records.ts`) filters
  `removedAt: null`: **the card's paperclip counts live files only.**
- `collectInlineAttachmentIds` is unchanged; an inline image that was removed
  is still `inline: true` and still renders, because the bytes are there and
  the `taskId` ACL arm still admits the viewer. The *Image removed* state of
  `AuthedAttachmentImage` stays for a row that is truly gone (a 404).
- `deleteTaskComment` no longer deletes files. It marks each
  `taskCommentId` file removed inside its transaction with the deleter as
  remover and `removedReason: COMMENT_REMOVAL_REASON`, skipping rows already
  removed, and writes one `attachment_removed` per file with `commentId`.
  Its `deps` lose `fileService`/`attribution`; `writeBack` stays.
- `linkUploadsToTask` is unchanged: a removed file is still linked (it has
  `taskId`), so it can never be re-linked elsewhere.
- `DELETE /api/attachments/:id` (`uploads.ts`) is unchanged: it refuses any
  `taskId`-linked row, removed or not. There is no path that deletes a ticket
  file's bytes short of deleting the task (cascade through the file service
  is out of scope, as today).

### 9.5 Routes, tools, realtime

`DELETE /api/tasks/:taskId/attachments/:attachmentId` takes an optional JSON
body `RemoveTaskAttachmentBody` and answers **200** with the updated
`TaskAttachmentRecord` (a 204 cannot carry who removed it); `ATTACHMENT_ALREADY_REMOVED`
maps to 409 in `sendTaskActivityError`. `DELETE /api/tasks/:taskId/comments/:commentId`
is unchanged on the wire. `publishTaskActivity` after both, as today —
content-free, nothing new.

| Tool | Change |
|---|---|
| `nessie_task_attachment_remove` | `+ reason?` (≤ 500); answers `{ removed: true, attachment }`; description: "Mark a file on a task as removed. It stays downloadable and the list shows who removed it and why; give a reason when you have one." |
| `nessie_task_attachment_list` / `_get` | rows carry `removed`; `_get` on a removed file still returns bytes, with `note: 'This file was removed from the task on <date> by <who>: <reason>'` |
| `ticket_attachment_remove` | `+ reason?`; result "Marked <file> as removed. It stays downloadable; the ticket shows who removed it and why." |
| `ticket_attachment_list` | a removed row's line ends `REMOVED <relative time> by <name or agent> — "<reason>"`; the header counts live files, then `(<n> removed)` |
| `ticket_comment_delete` | description drops "and the files attached to it" for "its files are marked removed and stay downloadable" |

`REFUSALS` in `ticket-attachments.ts` gains `ATTACHMENT_ALREADY_REMOVED:
'That file is already marked as removed.'` and rewrites
`ATTACHMENT_NOT_REMOVABLE` to "That file is a copy the external source
keeps; it cannot be removed here."

### 9.6 The row and the confirm — UI

`TaskAttachmentsSection`, one row per stored file, live or removed:

- **Live row** — unchanged anatomy: thumbnail, name (+ *in description* /
  *in comment* pill), meta line `size · uploader avatar+name · time`,
  Download, Remove (×).
- **Removed row** — the same row at reduced emphasis (`opacity` on the
  thumbnail and name, never a strike-through: a struck name reads as
  *deleted*), a muted `Removed` pill after the name, the meta line as above,
  and a **second line**: `Removed by {avatar+name} · {relative time}` then
  the reason in quotes when present, or the comment note in italics when it
  equals `COMMENT_REMOVAL_REASON`. Download stays; the × is not rendered.
  `data-attachment-removed="true"` on the `li`.
- **Header**: `Attachments · 3` counts live rows; `· 1 removed` follows when
  any. The empty state only when there are no rows at all.
- **Remove confirm** — always, not only for inline images. A new
  `RemoveAttachmentDialog` (`admin/src/components/features/projects/kanban/`)
  over the shared `Dialog`, because `ConfirmDialog` has no field:
  title `Remove “{filename}”?`; body *"It stays on the ticket, marked as
  removed by you, and can still be downloaded."* plus, for an inline file,
  *"It is shown in {the description | a comment} and keeps rendering there."*;
  a `Reason` textarea (`FormField` hint *Optional — why it is being removed*,
  counter at 500, `aria-label="Reason"`); buttons *Cancel* and *Remove*
  (destructive). Enter in the textarea inserts a newline; ⌘/Ctrl+Enter
  submits. On 409 the dialog closes and the list refetches — somebody else
  got there first, and the row now says who.
- `useRemoveTaskAttachment(taskId)` mutates `{ attachmentId, reason? }` and
  invalidates `taskKeys.all` as today.
- `KanbanCard` is unchanged; the count it receives already excludes removed
  files.

Copy, to the character: pill `Removed`; second line `Removed by {name} · {time}`;
reason rendered as `“{reason}”`; comment note `Removed with the comment.`;
confirm title `Remove “{filename}”?`; button `Remove`; header suffix
`· {n} removed`.

### 9.7 Audit

`attachment_removed { by, attachmentId, reason: string | null, commentId?: string }`
replaces the built payload (which had no reason). `api-and-services.md` §2.6's
table row for it is superseded by this line.

## 10. Waves

Three Opus implementers in one wave with **exclusive** file lists, after a
contract wave the orchestrator does alone, then an orchestrator integration
wave. Standing rules from [delivery.md](delivery.md) §6 apply unchanged:
worktree each, commit and push every turn, no `git add -A`, Prisma fakes
extended in the same commit as the query, tests where the package's `test`
script globs, a DB-backed test proved to fail without its fix, `--no-daemon`.

### 10.1 Wave 0 — the built contract (orchestrator)

```
api/prisma/schema.prisma                                                    §8.2, §9.2
api/prisma/migrations/20260921140000_board_labels_attachment_removal/migration.sql   §8.3, §9.2 (new)
packages/schemas/src/task-labels.ts · task-attachments.ts                   §8.6, §9.3
packages/team-admin/src/project-task-records.ts                             countTaskAttachments filters removedAt
packages/team-admin/src/task-access.ts                                      findAccessibleTask selects boardId
```

Gate: `pnpm --filter @nessie/api exec prisma generate`;
`pnpm exec turbo run build --no-daemon --filter=@nessie/schemas --filter=@nessie/team-admin`;
`pnpm exec turbo run typecheck --no-daemon` (it is **expected red** in
`task-labels.ts` and its callers — the point is to enumerate every site the
rename reaches, and the list goes into each agent's brief); the migration on
a clean pgvector container; `pnpm lint:migrations`.

### 10.2 Wave 1

**Agent A — server: labels re-keyed, removal, routes, tools.**

```
packages/team-admin/src/task-labels.ts · task-attachments.ts · task-comments.ts · project-tasks.ts
packages/team-admin/src/board-placement.ts (resolveTaskHomeBoard) · project-task-move.ts (rehomeTaskLabels) · board-structure.ts (rehomeBoardLabels in deleteBoard) · index.ts
packages/team-admin/test/task-labels.test.ts · task-attachments.test.ts · task-comments.test.ts · board-placement.test.ts
api/src/services/task-labels.ts · task-attachments.ts · task-comments.ts
api/src/routes/task-labels.ts · task-attachments.ts · task-comments.ts · task-activity-gate.ts · tasks.ts (error map)
api/test/task-labels-routes.test.ts · task-attachments-routes.test.ts · task-comments-routes.test.ts · attachment-unlinked-access.test.ts
api/src/mcp/tools/labels.ts · task-activity.ts · boards.ts (labelIds error text) · api/test/mcp-labels.test.ts · mcp-task-activity.test.ts
packages/runtime/src/builtin-ticket-tools.ts
worker/src/run/pa-tools/ticket-labels.ts · ticket-attachments.ts · ticket-comments.ts · tickets.ts (labelIds refusal text, ticket_read lines)
worker/test/pa-tools-ticket-activity.test.ts
```

Tests A must add or change (DB-backed where the query is the point):
`createBoardLabel` on two boards of one project accepts the same name and
refuses it on one board; `planTaskLabels` refuses a label from the task's
project but another board (`LABEL_NOT_ON_BOARD`) and resolves a `boardId:
null` task to the default board; a cross-board `moveProjectTask` re-homes a
Nessie-only label by creating it and a source-owned one by
`(sourceId, externalId)`, and adopts a same-name label on the target;
`deleteBoard` leaves every label reachable on the default board with its
links; `removeTaskAttachment` by a viewer who is neither uploader nor project
member succeeds, records remover and reason, refuses a second removal 409,
leaves the row downloadable through the `taskId` ACL arm, and excludes it
from `countTaskAttachments`; an unattended agent actor records
`removedByAgentId` alone; `deleteTaskComment` marks its files with
`COMMENT_REMOVAL_REASON` and calls no file service; the route answers 200
with `removed` filled; every tool's new input reaches the function
(`reason`, `boardId`) and the refusal sentences are the ones in §8.8/§9.5.

**Agent B — admin: the field, the settings tab, the row, browser coverage.**

```
admin/src/facades/task-labels/hooks.ts · task-attachments/hooks.ts · projects/keys.ts · agents/realtime.ts (if the key change needs it) · boards/resolve-home-board.ts (new, pure)
admin/src/components/features/projects/kanban/TaskLabelsField.tsx · TaskDialog.tsx · TaskAttachmentsSection.tsx · RemoveAttachmentDialog.tsx (new)
admin/src/pages/project/BoardSettingsPage.tsx · settings/LabelsSettingsSection.tsx · ProjectSettingsPage.tsx · admin/src/navigation/LegacyProjectLabelsRedirect.tsx (new) · navigation/surfaces.ts (only if the redirect needs a row)
admin/src/styles.css (removed-row emphasis only)
admin/test/query-key-invariants.test.ts · resolve-home-board.test.ts (new) · task-dialog-layout.test.ts (if the field's disabled branch moves) · dialog-adopters.test.ts (the new dialog's row)
admin/e2e/task-dialog/fixture.tsx · run.mjs
admin/e2e/project-usability/ticket-activity.mjs
```

Tests B must add: `resolveHomeBoardId` table (named board present, absent,
default, no boards); the fixture's stubbed client answers the board label
routes and a `DELETE …/attachments/:id` with a body; the removed row, the
confirm with a reason, and the *Manage labels…* href to the board's Labels
tab (§10.5).

**Agent C — sources, sync, migration proof.**

```
packages/team-admin/src/board-source-apply.ts (upsertSourceLabels per board, syncTaskSourceLabels resolves the home board)
packages/team-admin/test/board-source-apply.test.ts · board-source-apply-activity.test.ts (only where the label owner type changed)
worker/src/control/board-source-webhook.ts (label re-describe → updateMany) · board-source-sync.ts (owner type)
worker/test/board-source-sync-activity.test.ts
api/src/routes/board-sources/sources.ts (only if the attach seed names a label owner)
scripts or a throwaway harness under C's worktree for the migration proof — nothing committed outside the test files above
```

Tests C must add (DB-backed): a mirrored task on a non-default board gets
its source labels on that board, and the same provider label on a
default-board task is a second row; a webhook rename recolours both rows and
keeps a colliding name on the one board where it collides; the new
migration proof of §10.4 (project-scoped labels re-homed per board), run
on the upgrade baseline; the fingerprint is unchanged by the re-keying.

Wave 1 gate: `DATABASE_URL=… pnpm exec turbo run test --no-daemon` (whole
repo), root `pnpm lint` (migration and test-glob lints included),
`pnpm --filter @nessie/admin test`, `pnpm --filter @nessie/admin test:e2e:task-dialog`
(dev server and `NAV_E2E_ADMIN_MODE=preview` against a build made with the
flag), and `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:project-usability`
on this worktree's ports.

### 10.3 Wave 2 — integration and verification (orchestrator)

1. Integrate A, B, C; re-run the wave 1 gate from the integration branch.
2. Documentation (§10.6).
3. `gh workflow run browser-suites.yml --ref <branch>`.
4. Real-stack run against this worktree's admin port (the E2E recipe): the
   §10.5 project-usability steps, screenshots looked at and named in the
   report.
5. Open one new PR (PR #603 has merged); merge on green; clean up
   worktrees and branches.

### 10.4 Migration proof, spelled out

On a clean pgvector container: apply the chain up to `20260921120000`; seed
a project with two boards (one default), three project-scoped labels (one
used by a task on each board, one used by a `board_id IS NULL` task, one
unused) and their links; apply `20260921140000`; assert each label exists on
exactly the boards whose tasks use it plus the default board, every link
joins a task to a label on `coalesce(board_id, default)`, the new unique
indexes hold, and a project with no boards lost its labels. Then the whole
chain from empty, and the upgrade baseline: both apply cleanly.

### 10.5 Browser checks and screenshots

`admin/e2e/task-dialog/` (pure fixture) changes:

| Screenshot | What it pins now |
|---|---|
| `01-details-desktop.png` | as before; Attachments shows **four** rows: one live, one *in description*, one external link, one **removed** (dimmed, `Removed` pill, "Removed by … · 2 h ago · “Superseded by v2”") |
| `03-labels-open.png` | footer *Manage labels…* href is `/projects/<p>/boards/<default>/settings?tab=labels` (asserted, then shot) |
| `06-mirrored-readonly.png` | unchanged expectations; the fixture's source labels now carry `boardId` |
| `07-viewer-readonly.png` | no Remove on any row, the removed row still shows its Download |
| `10-labels-settings.png` | now the **board** settings page on its Labels tab, rename in progress, colour popover open; the tab strip shows General · Columns · Watchers · Labels |
| `11-card.png` | paperclip count is **2** with three stored rows, one removed (asserted) |
| `12-remove-confirm.png` (new) | the confirm over an inline image: both body sentences, the Reason textarea with text, the counter |
| `13-attachment-removed.png` (new) | after Remove: the row dimmed, the pill, the second line with the typed reason; the `DELETE` body asserted to carry `reason` |

`project-usability/ticket-activity.mjs` real-stack steps gain: remove the
uploaded file with a reason and assert the row's second line names the
signed-in person and the reason, the Download still works (a `GET` of
`downloadPath` answers 200), and the card's paperclip disappears; open the
board's Labels tab from the token footer, rename, and assert the pill on the
card follows (the step that exists today, retargeted); create a second board,
move the ticket there with the placement field, reopen it, and assert the
label is still on it and now listed under the second board's Labels tab.

### 10.6 Documentation that changes with the code

- `docs/standards/ticket-activity.md`: the **Labels** section says a label is
  board-scoped, unique by `normalizeLabelName` per board, source-owned per
  board, and follows a ticket by name across boards (`rehomeTaskLabels`,
  `rehomeBoardLabels`); the **Files** section replaces "Removing a file is its
  uploader's, or anyone who may modify the ticket's project … Deleting a
  comment deletes its files" with the §9.1 rule, the four columns, the 409,
  the count rule and "no path deletes a ticket file's bytes"; the surfaces
  table gains `boardId?` and `reason?`. `AGENTS.md` → Architecture's routing
  sentence changes because the invariant did: "labels belong to a board and
  follow a ticket by name; a removed file is marked and kept, never deleted".
- This folder's `overview.md`: §2 records the answers (done with this
  chapter), §1's label row is superseded by §8, §7 gains the two lines.
- `docs/plans/2026-09-06-nessie-mcp-server.md`: the label and attachment tool
  rows gain their new inputs.
- `CLAUDE.md`'s `test:e2e:task-dialog` bullet names the two new screenshots.
