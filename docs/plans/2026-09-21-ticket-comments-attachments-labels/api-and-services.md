# API and services

Part of [ticket comments, attachments and labels](overview.md).

## 2. API and services

### 2.1 Where the functions live, and the one rule

Every write is a function in `@nessie/team-admin`, re-exported by
`api/src/services/*`, called by the route, by the MCP tool and by the worker
builtin — the route-mirroring rule
([personal-assistant-tools.md](../../standards/personal-assistant-tools.md)).
No route decides a refusal; it maps a typed service result to a status.

New modules (each under the 500-line cap; split by the seams named):

```
packages/team-admin/src/task-labels.ts          label CRUD, listProjectLabels, setTaskLabels, label authority
packages/team-admin/src/task-comments.ts        list/create/update/delete, comment authority, the record mapper
packages/team-admin/src/task-attachments.ts     list, linkTaskAttachments, removeTaskAttachment, inline detection
packages/team-admin/src/task-access.ts          isTaskAccessibleToUser(prisma, viewer, taskId) — the one predicate
packages/team-admin/src/task-activity-realtime.ts publishTaskActivity (beside task-realtime.ts)
api/src/services/task-labels.ts · task-comments.ts · task-attachments.ts   (re-exports only)
api/src/routes/task-labels.ts · task-comments.ts · task-attachments.ts
```

`isTaskAccessibleToUser` is `getTask`'s visibility rule lifted into the
shared package: the task exists, is not deleted with its project, and its
`projectId` is in `listAccessibleProjectIds(viewer)` (or the viewer is an
org owner/admin, `'all'`). It exists so the attachment ACL, the comment
routes and the worker tools ask **one** question; `api/src/routes/tasks.ts`
`requireTaskAccess` keeps calling `getTask` and is unchanged.

### 2.2 Authority, decided once per noun

| Action | Who | Predicate | Refusal |
|---|---|---|---|
| Read labels of a project | anyone who can read the project | `isProjectAccessibleToActor` | 404 `PROJECT_NOT_FOUND` |
| Create / rename / recolour / delete a label | any project member, or org owner/admin | `canModifyProject` (`requireProjectModifier`) | 404 `PROJECT_NOT_FOUND` |
| Set a task's labels | anyone who can change the task | task access (`requireTaskAccess`) | 404 `NOT_FOUND` |
| Set a **source-owned** label on a mirrored task | as above, and the source is `read_write` | `writeBack` collaborator | 409 `SOURCE_READ_ONLY` / `SOURCE_REJECTED` |
| Read / add comments | anyone who can read the task | task access | 404 `NOT_FOUND` |
| Edit / delete a comment | **its author only** — the person, or the agent whose run wrote it | `comment.authorUserId === actor` (a PA acts as its person; an agent run's `authorAgentId` matches the run's agent) | 403 `COMMENT_NOT_AUTHOR` |
| Edit / delete an **imported** comment | its author, if an identity link resolves them, and the source is `read_write` and the adapter implements the write | write-back | 409 `SOURCE_READ_ONLY` / `COMMENT_NOT_WRITABLE` |
| Link an upload to a task / comment | anyone who can change the task, for uploads **they** made | `attachment.uploaderId === actor` and unlinked | ids that do not match are skipped, as `thread-message-create.ts` does; the response lists what linked |
| Remove an attachment | its uploader, or any project modifier | `uploaderId === actor || canModifyProject` | 403 `ATTACHMENT_NOT_REMOVABLE` |
| Read an attachment | anyone who can read its task | the `taskId` arm in `canAccessAttachment` | 404 |

Role comes from the verified request (`isAdminActor`) for routes and from
`resolveActingMember` for worker tools, as everywhere else.

**Source-owned vs Nessie-only labels on a mirrored ticket.** `setTaskLabels`
partitions the requested set by `label.sourceId === task.externalLink.sourceId`.
The Nessie-only partition is written locally, always. The source-owned
partition is compared with the current source-owned links: unchanged → no
write-back; changed → `writeBack.apply(link, { labelIds: [externalIds…] })`
before the local transaction, mirror rewritten from the echo (§5.7 of the
boards design, unchanged). A label that belongs to a *different* source than
the task's is refused `LABEL_NOT_IN_PROJECT_SOURCE` (400) — it cannot mean
anything upstream and would be silently dropped by the next sync.

### 2.3 Attachment access — the `taskId` arm

In `canAccessAttachment` (`api/src/services/attachments.ts`), after the
`emailMessageId` arm and before the knowledge-page denial:

```ts
if (attachment.taskId) {
  return isTaskAccessibleToUser(prisma, viewer, attachment.taskId)
}
```

`AttachmentAccessRow` gains `taskId`. `DELETE /api/attachments/:id` (the
"discard my unused upload" route) keeps refusing anything with `taskId` set,
as it does for `messageId` — a linked file is removed through the task
route, which is the door that also publishes and audits. The Prisma fake in
`api/test/attachment-unlinked-access.test.ts` gains the `task`/`project`
delegates and a task case (testing standard: teach the fake in the same
change).

`FileService.delete` remains the only place bytes go: `removeTaskAttachment`
and `deleteTaskComment` call it; a task hard-delete does not exist, and a
comment's attachments are deleted with the comment.

### 2.4 Uploads — one door, three link doors

No new multipart route. Files arrive through the existing
`POST /api/uploads` (25 MiB, secret scan, thumbnail job, uploader-only until
linked) and are linked by:

| Door | Body | Effect |
|---|---|---|
| `POST /api/tasks` | `attachmentIds?` | `updateMany({ id in ids, organizationId, uploaderId: actor, messageId: null, knowledgePageId: null, taskId: null }, { taskId })` inside the create transaction |
| `PATCH /api/tasks/:taskId` | `attachmentIds?` | same, for a description edited in place |
| `POST /api/tasks/:taskId/attachments` | `{ attachmentIds }` | same; the Attachments section's *Upload file* and the editor's image insert in edit mode |
| `POST /api/tasks/:taskId/comments` | `attachmentIds?` | sets `taskId` **and** `taskCommentId` |

The MCP `nessie_task_attachment_add` and the builtin `ticket_attachment_add`
are the two callers that reach `FileService.store` with `taskId` set at store
time (§3) — an agent has no composer to stage into, so its file is linked the
moment it exists.

The unlinked-upload gap (nothing reaps an upload that was never linked) is
pre-existing and shared with chat; this design does not widen it (every
client path links or discards) and does not close it.

### 2.5 Routes

Gate legend: **read** = `requireActorContext` + `requireUserActor` + task or
project access; **modify** = read + `requireProjectModifier`.

Labels — `api/src/routes/task-labels.ts`:

| Route | Gate | Body → result |
|---|---|---|
| `GET /api/projects/:projectId/labels` | read | `{ labels: TaskLabelRecord[] }` with `taskCount`, ordered by name |
| `POST /api/projects/:projectId/labels` | modify | `CreateTaskLabelBody` → 201 `TaskLabelRecord`; 409 `LABEL_NAME_TAKEN` (the existing label is returned in the error body so a picker can select it) |
| `PATCH /api/projects/:projectId/labels/:labelId` | modify | `UpdateTaskLabelBody`; 409 `LABEL_NAME_TAKEN`; a rename of a source-owned label is **local** and the next sync restores the provider's name — the response carries `external: true` so the UI can say so |
| `DELETE /api/projects/:projectId/labels/:labelId` | modify | links cascade; 204 |

Task labels — on `api/src/routes/tasks.ts`: `PATCH /api/tasks/:taskId` and
`POST /api/tasks` accept `labelIds` (replace-set) and route it to
`setTaskLabels` inside `updateProjectTask` / `createProjectTask`; new refusals
`LABEL_NOT_IN_PROJECT` (400), `LABEL_NOT_IN_PROJECT_SOURCE` (400),
`SOURCE_READ_ONLY` / `SOURCE_REJECTED` (409, as for title).

Comments — `api/src/routes/task-comments.ts`:

| Route | Gate | Body → result |
|---|---|---|
| `GET /api/tasks/:taskId/comments?cursor&limit` | read | `TaskCommentList`, oldest first, keyset on `(createdAt, id)`, `limit` ≤ 100 default 50, `total` excludes deleted |
| `POST /api/tasks/:taskId/comments` | read | `CreateTaskCommentBody` → 201 `TaskCommentRecord`; on a `read_write` mirrored task the adapter's `createComment` runs first and the row is written from its echo (`externalId` set) |
| `PATCH /api/tasks/:taskId/comments/:commentId` | author | `UpdateTaskCommentBody` → `TaskCommentRecord` with `editedAt` |
| `DELETE /api/tasks/:taskId/comments/:commentId` | author | 204; blanks `body`, sets `deletedAt`, deletes its attachments through `FileService` |

Attachments — `api/src/routes/task-attachments.ts`:

| Route | Gate | Body → result |
|---|---|---|
| `GET /api/tasks/:taskId/attachments` | read | `TaskAttachmentList`: stored files (`Attachment.taskId`) ∪ external `link`/`failed` assets, newest first, `inline` computed against `detail` and live comment bodies |
| `POST /api/tasks/:taskId/attachments` | read | `LinkTaskAttachmentsBody` → `{ attachments }` (the rows that linked) |
| `DELETE /api/tasks/:taskId/attachments/:attachmentId` | uploader or modify | 204; refuses `ATTACHMENT_NOT_ON_TASK` (404) when the id is not on this task |

`api/src/register-api-routes.ts` registers the three files beside
`task-fields.ts`.

### 2.6 `TaskEvent` audit

`TaskEvent` has no actor column; every kind carries `by` in `payload`, as the
existing kinds do (`created`, `assigned`, `status_changed`, …). The event is
the ticket's own history; the organisation audit log keeps riding
`emitAuditEvent` where the sibling task routes use it, with `via`
(`mcp_agent_credential`, an agent run) stamped by the actor context, never by
the tool (paired-agents standard).

| `eventType` | `payload` |
|---|---|
| `labels_changed` | `{ by, added: labelId[], removed: labelId[], bySourceId? }` — `bySourceId` when sync wrote it |
| `comment_added` | `{ by, commentId, agentId?, bySourceId?, externalId? }` |
| `comment_edited` | `{ by, commentId }` |
| `comment_deleted` | `{ by, commentId }` |
| `attachment_added` | `{ by, attachmentIds, commentId?, bySourceId? }` |
| `attachment_removed` | `{ by, attachmentId }` |
| `detail_edited` | `{ by }` — written by `updateProjectTask` when `detail` changes, so the description has a history line at all |

`by` is the acting user id, or `agent:<id>` for an unattended agent run, or
`source:<id>` for sync — the same three shapes `status_changed` already uses.
A single `updateProjectTask` call that changes labels and detail writes both
rows in its transaction.

### 2.7 Realtime

Two content-free event **names** inside the existing envelope. Neither adds
a top-level field, so an old replica's fan-out (`kind`, `eventId`,
`scopes.filter`) finds nothing new to dereference, and an old admin client's
`safeParse` drops the unknown name — the inert rule
([storage-and-realtime.md](../../standards/horizontal-scaling/storage-and-realtime.md)
"A notification must be inert to the build it is replacing") is satisfied
without a `*-ref` shim.

| Event | Payload | Published by | Admin reaction |
|---|---|---|---|
| `task.activity` | `{ taskId, projectId }` | `publishTaskActivity` from create/update/delete comment, link/remove attachment, and once per sync job that touched comments or assets | invalidate `taskKeys.comments(taskId)`, `taskKeys.attachments(taskId)`, `taskKeys.presented(taskId)` |
| `task.updated` | existing `{ taskId, status }` | **now also** from `PATCH /api/tasks/:taskId` and `POST …/assign`/`move` (today the REST routes publish nothing) | existing handler: `taskKeys.all` |
| `board.updated` | existing `{ projectId }` | label create/rename/recolour/delete (cards repaint) | existing handler |

All on the `organization` scope; the refetch is the entitlement check, the
`board.updated` reasoning. `taskKeys` gains `comments(taskId)` and
`attachments(taskId)` under the `['tasks', …]` root so `taskKeys.all`
invalidation still reaches them (query-key invariants test). `projectKeys`
gains `labels(projectId)`.

### 2.8 Search and disclosure

`GET /api/tasks/search` and `ticket_search` keep matching title, purpose,
detail and key. Comment bodies are **not** searched in v1 — search fails
closed on anything carrying a basis, and comment text has not been given one;
adding it is a follow-up with its own disclosure read. Worker reads of
comments and attachments stamp the same `project:` scope `ticket_read` stamps
(`recordProjectRead`), and an attachment read into a run's context goes
through the existing `attachment_read` builtin, whose bytes come from the one
chokepoint and whose access is the new `taskId` arm.
