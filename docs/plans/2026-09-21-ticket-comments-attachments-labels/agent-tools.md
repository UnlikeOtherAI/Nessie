# Agent tools

Part of [ticket comments, attachments and labels](overview.md).

## 3. Agent tools

"Reflected in the MCP" is a test of reach: every capability a person gets in
the dialog must be reachable by an agent through a tool that calls the same
`@nessie/team-admin` function the route calls. Three surfaces exist and all
three change:

1. **Nessie's MCP server** (`POST /mcp`, paired credentials) —
   `api/src/mcp/tools/`. Names are `nessie_<surface>_<verb>`; scopes are the
   four coarse ones; each result carries `origin` for a task.
2. **The Personal Assistant's builtins** — `packages/runtime/src/builtin-ticket-tools.ts`
   definitions, `worker/src/run/pa-tools/` implementations, all
   `category: 'projects'`, `personalAssistantOnly: true`.
3. **The peer-delegated subset a shared agent gets in a project channel** —
   the same builtins flagged `projectDelegatedOnly`, admitted by
   `PEER_PROJECT_TOOL_IDS` in `worker/src/run/execute/run-setup.ts`.

### 3.1 MCP tools

New file `api/src/mcp/tools/task-activity.ts` (comments + attachments) and
`api/src/mcp/tools/labels.ts`; `boards.ts` changes as noted;
`api/src/mcp/server.ts` spreads both. Every tool re-reads task reach through
`context.getTask` (the same `listAccessibleProjectIds` narrowing) and maps
service refusals through the existing `describeWriteFailure`, extended with
the new codes.

| Tool | Scope | Input (zod raw shape) | Output |
|---|---|---|---|
| `nessie_task_get` | `boards_read` | `{ taskId }` | **now** `{ origin, task, labels: TaskLabelSummary[], attachments: TaskAttachmentRecord[], commentCount }` — `task.detail` is documented as Markdown in the description |
| `nessie_task_create` | `boards_write` | `+ labelIds?: uuid[]` | unchanged shape, `task.labels` filled |
| `nessie_task_update` | `boards_write` | `+ labelIds?: uuid[]` (replace-set); `detail` documented as Markdown, images as `![alt](/api/attachments/<id>)` | unchanged |
| `nessie_task_comment_list` | `boards_read` | `{ taskId, cursor?, limit? ≤100 }` | `{ comments, nextCursor, total }` — author as `TaskCommentAuthor`; a `user` author is an id the agent may resolve, never a name |
| `nessie_task_comment_add` | `boards_write` | `{ taskId, body: string.min(1).max(20000) }` | `{ comment, origin }`; on a `read_write` mirrored task the comment is created upstream first and `comment.external` is set; on `read_only` it is created locally and the result says `propagated: false` with the sentence *"This ticket mirrors Linear read-only; the comment stays in Nessie."* |
| `nessie_task_comment_update` | `boards_write` | `{ taskId, commentId, body }` | `{ comment }`; `COMMENT_NOT_AUTHOR` in words: *"Only its author can change a comment."* |
| `nessie_task_comment_delete` | `boards_write` | `{ taskId, commentId }` | `{ deleted: true }` |
| `nessie_task_attachment_list` | `boards_read` | `{ taskId }` | `{ attachments }` (the same record the route returns, `downloadPath` included) |
| `nessie_task_attachment_add` | `boards_write` | `{ taskId, filename: string.max(255), mime: string, contentBase64: string }` — decoded size ≤ 10 MiB (`ATTACHMENT_TOO_LARGE` otherwise) | `{ attachment }`; stores through `FileService.store({ …, taskId })` — linked at store time, the `attachment_upload` builtin's shape |
| `nessie_task_attachment_get` | `boards_read` | `{ taskId, attachmentId }` | `{ attachment, contentBase64? }` — bytes inlined for `image/*` and `text/*` ≤ 4 MiB (the run-context image cap), otherwise metadata and `downloadPath` only, with the sentence that the download needs the credential's bearer |
| `nessie_task_attachment_remove` | `boards_write` | `{ taskId, attachmentId }` | `{ removed: true }`; `ATTACHMENT_NOT_REMOVABLE` in words |
| `nessie_label_list` | `boards_read` | `{ projectId }` | `{ labels: TaskLabelRecord[] }` with `taskCount` |
| `nessie_label_create` | `boards_write` | `{ projectId, name: string.max(60), color?: '#rrggbb' }` | `{ label }`; `LABEL_NAME_TAKEN` returns `{ error, label }` so the agent uses the existing one |
| `nessie_label_update` | `boards_write` | `{ projectId, labelId, name?, color? }` | `{ label }`; a source-owned rename answers `{ label, warning: 'Linear owns this label's name; the next sync restores it.' }` |
| `nessie_label_delete` | `boards_write` | `{ projectId, labelId }` | `{ deleted: true, removedFromTasks: n }` |

`describeWriteFailure` gains `LABEL_NOT_IN_PROJECT`,
`LABEL_NOT_IN_PROJECT_SOURCE`, `LABEL_NAME_TAKEN`, `COMMENT_NOT_AUTHOR`,
`COMMENT_NOT_WRITABLE`, `ATTACHMENT_NOT_REMOVABLE`, `ATTACHMENT_TOO_LARGE`
(all `retryable: false`).

The MCP server has no `category` field on `McpToolDefinition` today (the
tool-categories standard names `nessie_sheet_*` as declaring one, which the
code does not do). This design does not add one — it is a standing mismatch
to record, not widen.

Scopes stay the four coarse ones: label management is `boards_write`, because
a label is board shape and the scope table describes reach, not risk. No new
scope, and no publish-style approval — none of these writes is a publication.

### 3.2 PA and peer builtins

Definitions in `packages/runtime/src/builtin-ticket-tools.ts` (append to
`TICKET_TOOL_DEFINITIONS`; the file is at 121 lines and stays under the cap),
implementations split into `worker/src/run/pa-tools/ticket-comments.ts`,
`ticket-labels.ts`, `ticket-attachments.ts`. All `category: 'projects'`,
`personalAssistantOnly: true`; `projectDelegatedOnly: true` where the table
says so, which is also the set added to `PEER_PROJECT_TOOL_IDS`.

| id | delegated | mirrors | notes |
|---|---|---|---|
| `ticket_read` | yes (exists) | `GET /api/tasks/:id` | output gains a `Labels:` line (names), `Attachments: n` and `Comments: n` lines, and the origin line the MCP already gives |
| `ticket_update` | yes (exists) | `PATCH /api/tasks/:id` | gains `labelIds` |
| `ticket_labels_read` | yes | `GET …/labels` | `safe: true`; the resolving read for `labelIds` (a tool that takes an id ships with the read that resolves it) |
| `ticket_label_create` | yes | `POST …/labels` | `{ projectId, name, color? }`; `LABEL_NAME_TAKEN` answers with the existing label |
| `ticket_comment_list` | yes | `GET …/comments` | `safe: true`; stamps `project:` through `recordProjectRead`; authors printed as *person* / *agent* / *provider user* with the id on the line, never a name from a local copy |
| `ticket_comment_add` | yes | `POST …/comments` | on a PA turn the author is the acting person; on a shared agent's turn the author is **the agent** (`authorAgentId`) and the requesting person is `payload.by` |
| `ticket_comment_update` / `ticket_comment_delete` | no (PA only) | `PATCH`/`DELETE …/comments/:id` | author-only; a shared agent may only change the comments it authored, so these stay off the peer set in v1 |
| `ticket_attachment_list` | yes | `GET …/attachments` | `safe: true`; stamps `project:` |
| `ticket_attachment_add` | yes | `POST …/attachments` | `{ ticketId, attachmentId }` — links an attachment the run already produced through `attachment_upload` or a message; the link door, exactly like a person's composer |
| `ticket_attachment_remove` | no (PA only) | `DELETE …/attachments/:id` | uploader-or-modifier, as the route |

Label **rename/recolour/delete** deliberately have no PA tool, matching the
boards design's "board, field and source administration has no PA tools":
they are set up on a settings page and the PA's job is the work. `nessie_label_*`
on the MCP does have them because a paired CLI agent has no settings page —
the same reasoning that gave the MCP `nessie_doc_update` and not the PA.

`EFFECTFUL_TOOL_CATEGORY_IDS` already includes `projects`, so every write
above is claimed in the tool-effect ledger before it runs.

### 3.3 Disclosure

A comment or attachment read that enters a run's context is a read of
project material: `ticket_comment_list` and `ticket_attachment_list` call
`recordProjectRead` exactly as `ticket_read` does (stamping `project:` for
non-owners). Bytes reach the context only through `attachment_read`, whose
access is now the `taskId` arm of `canAccessAttachment`. Nothing here adds a
second scope vocabulary; comments carry the task's project basis and nothing
finer, which is what §4.3 guarantees for everything imported.
